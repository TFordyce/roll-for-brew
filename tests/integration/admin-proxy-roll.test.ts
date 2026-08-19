import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises Proxy
// Roll (issue #273, CONTEXT.md's "Proxy Roll" glossary entry): admin_proxy_roll
// (supabase/migrations/0071_admin_proxy_roll.sql).
describe.skipIf(!hasAnonTestEnv)("admin_proxy_roll (Proxy Roll, issue #273)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  function signUp(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }

  async function makeAdmin(playerId: string) {
    const { error } = await admin.from("players").update({ is_admin: true }).eq("id", playerId);
    if (error) throw error;
  }

  /**
   * Seeds an "absent" real player directly (a public.players row with no
   * room_players row anywhere) — the whole point of Proxy Roll is folding in
   * someone who never went through signUpSignInAndEnterRoom's own
   * enter_todays_room call today.
   */
  async function seedAbsentPlayer(label: string): Promise<string> {
    const playerId = `proxy-roll-absent-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cleanup.trackPlayerId(playerId);
    const { error } = await admin
      .from("players")
      .insert({ id: playerId, email: `${playerId}@example.com`, display_name: `Absent ${label}` });
    if (error) throw error;
    return playerId;
  }

  it("folds an absent player into an open round as a full participant", async () => {
    const { client: adminClient, googleSub: adminSub } = await signUp("proxy-open-admin");
    await makeAdmin(adminSub);
    const absentId = await seedAbsentPlayer("open");

    const { data: roundId } = await adminClient.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error } = await adminClient.rpc("admin_proxy_roll", {
      p_round_id: roundId,
      p_player_id: absentId,
      p_value: 14,
    });
    expect(error).toBeNull();

    const { data: roomPlayer } = await admin
      .from("room_players")
      .select("player_id")
      .eq("room_id", (await adminClient.rpc("enter_todays_room")).data as string)
      .eq("player_id", absentId)
      .maybeSingle();
    expect(roomPlayer).not.toBeNull();

    const { data: participant } = await admin
      .from("round_participants")
      .select("player_id")
      .eq("round_id", roundId)
      .eq("player_id", absentId)
      .maybeSingle();
    expect(participant).not.toBeNull();

    const { data: roll } = await admin
      .from("rolls")
      .select("value, input_mode, entered_by_admin")
      .eq("round_id", roundId)
      .eq("player_id", absentId)
      .single();
    expect(roll).toEqual({ value: 14, input_mode: "manual", entered_by_admin: true });
  });

  it("folds an absent player into a closed round with no rolls yet", async () => {
    const { client: adminClient, googleSub: adminSub } = await signUp("proxy-closed-admin");
    await makeAdmin(adminSub);
    const { client: otherClient } = await signUp("proxy-closed-other");
    const absentId = await seedAbsentPlayer("closed");

    const { data: roundId } = await adminClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });
    await adminClient.rpc("close_round", { p_round_id: roundId });

    const { error } = await adminClient.rpc("admin_proxy_roll", {
      p_round_id: roundId,
      p_player_id: absentId,
      p_value: 7,
    });
    expect(error).toBeNull();
  });

  it("rejects a non-admin caller", async () => {
    const { client: nonAdminClient } = await signUp("proxy-non-admin");
    const absentId = await seedAbsentPlayer("non-admin");

    const { data: roundId } = await nonAdminClient.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error } = await nonAdminClient.rpc("admin_proxy_roll", {
      p_round_id: roundId,
      p_player_id: absentId,
      p_value: 10,
    });
    expect(error).not.toBeNull();
  });

  it("fails once a roll has already landed for the round (RFB32)", async () => {
    const { client: adminClient, googleSub: adminSub } = await signUp("proxy-rolled-admin");
    await makeAdmin(adminSub);
    const { client: otherClient } = await signUp("proxy-rolled-other");
    const absentId = await seedAbsentPlayer("rolled");

    const { data: roundId } = await adminClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });
    await adminClient.rpc("close_round", { p_round_id: roundId });
    await adminClient.rpc("submit_roll", { p_round_id: roundId });

    const { error } = await adminClient.rpc("admin_proxy_roll", {
      p_round_id: roundId,
      p_player_id: absentId,
      p_value: 10,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB32");
  });

  it("records a pending spell draw for the proxied player, not the admin, on a nat-20", async () => {
    const { client: adminClient, googleSub: adminSub } = await signUp("proxy-nat20-admin");
    await makeAdmin(adminSub);
    const absentId = await seedAbsentPlayer("nat20");

    const { data: roundId } = await adminClient.rpc("start_round");
    cleanup.trackRound(roundId as string);

    await adminClient.rpc("admin_proxy_roll", {
      p_round_id: roundId,
      p_player_id: absentId,
      p_value: 20,
    });

    const { data: pending } = await admin
      .from("pending_spell_draws")
      .select("player_id, trigger")
      .eq("round_id", roundId);
    expect(pending).toEqual([{ player_id: absentId, trigger: "nat20" }]);
  });
});
