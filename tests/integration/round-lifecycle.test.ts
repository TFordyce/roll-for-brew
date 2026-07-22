import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestAnonClient,
  createTestCleanup,
  hasAnonTestEnv,
  hasTestEnv,
  uniqueTestEmail,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// start_round / declare_in / close_round RPCs
// (supabase/migrations/0004_round_lifecycle.sql) through real signed-in
// sessions, the same way the app drives them.
describe.skipIf(!hasAnonTestEnv)("round lifecycle (start_round / declare_in / close_round)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  async function signUpSignInAndEnterRoom(label: string) {
    const email = uniqueTestEmail(label);
    const password = `Test-password-${Math.random().toString(36).slice(2)}!`;
    const googleSub = `google-sub-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cleanup.trackWhitelistedEmail(email);
    cleanup.trackPlayerId(googleSub);

    await admin.from("whitelist").insert({ email: email.toLowerCase() });
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { sub: googleSub, name: `Player ${label}` },
    });
    expect(error).toBeNull();
    cleanup.trackUser(data.user!.id);

    const client = createTestAnonClient();
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    const { data: roomId, error: roomError } = await client.rpc("enter_todays_room");
    expect(roomError).toBeNull();

    return { client, googleSub, roomId: roomId as string };
  }

  it("starting a round auto-enrolls the starter as its first participant", async () => {
    const { client, googleSub, roomId } = await signUpSignInAndEnterRoom("starter");

    const { data: roundId, error } = await client.rpc("start_round");
    expect(error).toBeNull();
    expect(roundId).toBeTruthy();
    cleanup.trackRound(roundId as string);

    const { data: round, error: roundError } = await admin
      .from("rounds")
      .select("id, room_id, started_by, status")
      .eq("id", roundId)
      .single();
    expect(roundError).toBeNull();
    expect(round).toMatchObject({ room_id: roomId, started_by: googleSub, status: "open" });

    const { data: participants, error: participantsError } = await admin
      .from("round_participants")
      .select("player_id")
      .eq("round_id", roundId);
    expect(participantsError).toBeNull();
    expect(participants).toEqual([{ player_id: googleSub }]);
  });

  it("rejects a second start attempt while a round is already open in the same room", async () => {
    const { client } = await signUpSignInAndEnterRoom("double-start");

    const { data: roundId, error: firstError } = await client.rpc("start_round");
    expect(firstError).toBeNull();
    cleanup.trackRound(roundId as string);

    const { error: secondError } = await client.rpc("start_round");
    expect(secondError).not.toBeNull();
  });

  it("lets another present player declare in while the round is open", async () => {
    const { client: starterClient, googleSub: starterSub } =
      await signUpSignInAndEnterRoom("declare-starter");
    const { client: otherClient, googleSub: otherSub } =
      await signUpSignInAndEnterRoom("declare-other");

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error: declareError } = await otherClient.rpc("declare_in", {
      p_round_id: roundId,
    });
    expect(declareError).toBeNull();

    const { data: participants } = await admin
      .from("round_participants")
      .select("player_id")
      .eq("round_id", roundId);

    expect(new Set(participants!.map((p) => p.player_id))).toEqual(
      new Set([starterSub, otherSub]),
    );
  });

  it("rejects a close attempt from anyone other than the round's starter", async () => {
    const { client: starterClient } = await signUpSignInAndEnterRoom("close-auth-starter");
    const { client: otherClient } = await signUpSignInAndEnterRoom("close-auth-other");

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });

    const { error: closeError } = await otherClient.rpc("close_round", {
      p_round_id: roundId,
    });
    expect(closeError).not.toBeNull();

    const { data: round } = await admin.from("rounds").select("status").eq("id", roundId).single();
    expect(round?.status).toBe("open");
  });

  it("blocks close until at least 2 players have declared in", async () => {
    const { client: starterClient } = await signUpSignInAndEnterRoom("gate-starter");

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error: closeError } = await starterClient.rpc("close_round", {
      p_round_id: roundId,
    });
    expect(closeError).not.toBeNull();

    const { data: round } = await admin.from("rounds").select("status").eq("id", roundId).single();
    expect(round?.status).toBe("open");
  });

  it("lets the starter close once at least 2 players have declared in", async () => {
    const { client: starterClient } = await signUpSignInAndEnterRoom("gate-pass-starter");
    const { client: otherClient } = await signUpSignInAndEnterRoom("gate-pass-other");

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });

    const { error: closeError } = await starterClient.rpc("close_round", {
      p_round_id: roundId,
    });
    expect(closeError).toBeNull();

    const { data: round } = await admin.from("rounds").select("status").eq("id", roundId).single();
    expect(round?.status).toBe("closed");
  });

  it("does not retroactively add a player who logs in mid-day to an already-open round", async () => {
    const { client: starterClient } = await signUpSignInAndEnterRoom("mid-day-starter");
    const { googleSub: lateSub } = await signUpSignInAndEnterRoom("mid-day-late");

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { data: participants } = await admin
      .from("round_participants")
      .select("player_id")
      .eq("round_id", roundId);

    expect(participants!.some((p) => p.player_id === lateSub)).toBe(false);
  });
});

// Schema-level checks that don't depend on "today" or real auth sessions,
// using explicit seeded data via the admin (service-role) client directly —
// mirrors the "enforces one room per date" pattern in
// tests/integration/room-auto-creation.test.ts.
describe.skipIf(!hasTestEnv)("rounds_one_active_per_room constraint", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  it("allows only one open-or-closed round per room at a time", async () => {
    const email = uniqueTestEmail("constraint-player");
    const googleSub = `google-sub-constraint-${Date.now()}`;
    cleanup.trackPlayerId(googleSub);
    await admin.from("players").insert({ id: googleSub, email, display_name: "Constraint Player" });

    const { data: room } = await admin
      .from("rooms")
      .insert({ date: "2020-03-03" })
      .select("id")
      .single();
    cleanup.trackRoom(room!.id);

    const { data: firstRound, error: firstError } = await admin
      .from("rounds")
      .insert({ room_id: room!.id, started_by: googleSub, status: "open" })
      .select("id")
      .single();
    expect(firstError).toBeNull();
    cleanup.trackRound(firstRound!.id);

    const { error: secondError } = await admin
      .from("rounds")
      .insert({ room_id: room!.id, started_by: googleSub, status: "open" });
    expect(secondError).not.toBeNull();

    // A resolved/cancelled round doesn't count as active, so a new one can
    // start once the prior one is out of the way.
    await admin.from("rounds").update({ status: "resolved" }).eq("id", firstRound!.id);

    const { data: thirdRound, error: thirdError } = await admin
      .from("rounds")
      .insert({ room_id: room!.id, started_by: googleSub, status: "open" })
      .select("id")
      .single();
    expect(thirdError).toBeNull();
    cleanup.trackRound(thirdRound!.id);
  });
});
