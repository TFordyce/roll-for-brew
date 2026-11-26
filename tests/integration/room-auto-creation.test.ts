import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasTestEnv,
  uniqueTestEmail,
} from "./setup";

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
