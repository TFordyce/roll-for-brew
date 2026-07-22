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

// Runs against a real, dedicated test Supabase project (see .env.example).
// Exercises the actual enter_todays_room RPC
// (supabase/migrations/0003_rooms_and_room_players.sql) through a real
// signed-in session, the same way a whitelisted login drives it.
describe.skipIf(!hasAnonTestEnv)("room auto-creation (enter_todays_room RPC)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  async function signUpAndSignIn(label: string) {
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
    const { data: session, error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    expect(signInError).toBeNull();
    expect(session.session).not.toBeNull();

    return { client, googleSub };
  }

  it("creates today's room and a room_players row with modifier 0 on first login", async () => {
    const { client, googleSub } = await signUpAndSignIn("first-entry");

    const { data: roomId, error } = await client.rpc("enter_todays_room");
    expect(error).toBeNull();
    expect(roomId).toBeTruthy();

    const { data: room, error: roomError } = await admin
      .from("rooms")
      .select("id, date")
      .eq("id", roomId)
      .single();
    expect(roomError).toBeNull();
    expect(room?.id).toBe(roomId);

    const { data: roomPlayer, error: roomPlayerError } = await admin
      .from("room_players")
      .select("room_id, player_id, modifier")
      .eq("room_id", roomId)
      .eq("player_id", googleSub)
      .single();
    expect(roomPlayerError).toBeNull();
    expect(roomPlayer).toMatchObject({ room_id: roomId, player_id: googleSub, modifier: 0 });
  });

  it("does not duplicate the room on repeated logins the same day", async () => {
    const { client } = await signUpAndSignIn("repeat-entry");

    const { data: firstRoomId } = await client.rpc("enter_todays_room");
    const { data: secondRoomId } = await client.rpc("enter_todays_room");

    expect(secondRoomId).toBe(firstRoomId);

    const { data: room } = await admin
      .from("rooms")
      .select("id, date")
      .eq("id", firstRoomId)
      .single();

    const { count } = await admin
      .from("rooms")
      .select("id", { count: "exact", head: true })
      .eq("date", room!.date);

    expect(count).toBe(1);
  });

  it("does not reset an existing room_players row's modifier on a repeat login", async () => {
    const { client, googleSub } = await signUpAndSignIn("preserve-modifier");

    const { data: roomId } = await client.rpc("enter_todays_room");
    await admin.from("room_players").update({ modifier: 7 }).eq("room_id", roomId).eq(
      "player_id",
      googleSub,
    );

    await client.rpc("enter_todays_room");

    const { data: roomPlayer } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", roomId)
      .eq("player_id", googleSub)
      .single();

    expect(roomPlayer?.modifier).toBe(7);
  });

  it("joins the same room for two different whitelisted players logging in the same day", async () => {
    const { client: clientA } = await signUpAndSignIn("shared-room-a");
    const { client: clientB } = await signUpAndSignIn("shared-room-b");

    const { data: roomIdA } = await clientA.rpc("enter_todays_room");
    const { data: roomIdB } = await clientB.rpc("enter_todays_room");

    expect(roomIdB).toBe(roomIdA);
  });
});

// Schema-level checks that don't depend on "today", using explicit seeded
// dates via the admin (service-role) client directly.
describe.skipIf(!hasTestEnv)("room isolation across days", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  it("keeps modifiers scoped to their own room, independent of other days", async () => {
    const email = uniqueTestEmail("isolation-player");
    const googleSub = `google-sub-isolation-${Date.now()}`;
    cleanup.trackPlayerId(googleSub);
    await admin
      .from("players")
      .insert({ id: googleSub, email, display_name: "Isolation Player" });

    const dateA = "2020-01-01";
    const dateB = "2020-01-02";

    const { data: roomA } = await admin
      .from("rooms")
      .insert({ date: dateA })
      .select("id")
      .single();
    cleanup.trackRoom(roomA!.id);

    const { data: roomB } = await admin
      .from("rooms")
      .insert({ date: dateB })
      .select("id")
      .single();
    cleanup.trackRoom(roomB!.id);

    await admin
      .from("room_players")
      .insert({ room_id: roomA!.id, player_id: googleSub, modifier: 5 });
    await admin
      .from("room_players")
      .insert({ room_id: roomB!.id, player_id: googleSub, modifier: 0 });

    const { data: rows } = await admin
      .from("room_players")
      .select("room_id, modifier")
      .eq("player_id", googleSub)
      .in("room_id", [roomA!.id, roomB!.id]);

    const byRoom = new Map(rows!.map((r) => [r.room_id, r.modifier]));
    expect(byRoom.get(roomA!.id)).toBe(5);
    expect(byRoom.get(roomB!.id)).toBe(0);
  });

  it("enforces one room per date", async () => {
    const date = "2020-06-15";
    const { data: room } = await admin.from("rooms").insert({ date }).select("id").single();
    cleanup.trackRoom(room!.id);

    const { error } = await admin.from("rooms").insert({ date });
    expect(error).not.toBeNull();
  });
});
