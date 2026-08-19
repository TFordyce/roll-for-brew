import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, forceHold, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// admin "draw for others" nat-1 forced-swap behaviour (0070, issue #267)
// on draw_spell_card_as — the Test Room puppet-testing path must behave
// the same as the real in-app draw_spell_card path.
describe.skipIf(!hasAnonTestEnv)("draw_spell_card_as: forced swap on nat1 (issue #267)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  function signUpSignInAndEnter(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }

  async function makeAdmin(playerId: string) {
    const { error } = await admin.from("players").update({ is_admin: true }).eq("id", playerId);
    if (error) throw error;
  }

  it("forces the swap on nat1 for the target player, same as the in-app path", async () => {
    const { client: adminClient, googleSub: adminId } = await signUpSignInAndEnter("draw-as-admin");
    await makeAdmin(adminId);

    const { googleSub: targetId, roomId } = await signUpSignInAndEnter("draw-as-target");
    await admin.from("rooms").update({ is_test: true }).eq("id", roomId);
    const oldInstanceId = await forceHold(admin, targetId, "Lucky Sip");

    const { data, error } = await adminClient.rpc("draw_spell_card_as", {
      p_trigger: "nat1",
      p_room_id: roomId,
      p_player_id: targetId,
    });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
    expect(row!.needs_swap_decision).toBe(false);

    const { data: oldInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", oldInstanceId)
      .single();
    expect(oldInstance).toEqual({ location: "in_deck", held_by_player: null });

    const { data: newInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", row!.instance_id)
      .single();
    expect(newInstance).toEqual({ location: "held", held_by_player: targetId });
  });

  it("still parks as pending_swap on nat20, unaffected by the nat1 forced path", async () => {
    const { client: adminClient, googleSub: adminId } = await signUpSignInAndEnter("draw-as-admin-nat20");
    await makeAdmin(adminId);

    const { googleSub: targetId, roomId } = await signUpSignInAndEnter("draw-as-target-nat20");
    await admin.from("rooms").update({ is_test: true }).eq("id", roomId);
    await forceHold(admin, targetId, "Lucky Sip");

    const { data, error } = await adminClient.rpc("draw_spell_card_as", {
      p_trigger: "nat20",
      p_room_id: roomId,
      p_player_id: targetId,
    });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
    expect(row!.needs_swap_decision).toBe(true);

    const { data: newInstance } = await admin
      .from("spell_deck_instances")
      .select("location")
      .eq("id", row!.instance_id)
      .single();
    expect(newInstance).toEqual({ location: "pending_swap" });
  });
});
