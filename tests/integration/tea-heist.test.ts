import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Exercises Tea Heist (issue #438,
// spec #401): "Steal a card from another player's hand. They draw nothing in
// return."
//
// The cast pins the victim's held card; the card only moves when the round
// finalizes (finalize_layer's commit step, ADR 0005 #383 amendment as
// re-amended by #438), never at cast time and never when a viewer's
// Provisional Recap dry-runs the resolver. Countered: nothing moves. The
// victim playing the pinned card first (including as a counter): fizzles. A
// Time for Brew replay hands the card back.
//
// Assertions are on observable outcomes only: card locations / holders, the
// finalize_layer result and the Resolution Trace.

describe.skipIf(!hasAnonTestEnv)("Tea Heist (issue #438)", () => {
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

  type Player = Awaited<ReturnType<typeof signUp>>;

  async function startRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function instance(id: string) {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", id)
      .single();
    expect(error).toBeNull();
    return data as { location: string; held_by_player: string | null };
  }

  // ==========================================================================
  // Picker + cast validation
  // ==========================================================================

  it("get_heist_targets lists only other participants holding a card, and only for the Tea Heist holder", async () => {
    const [thief, holder, emptyHanded] = await Promise.all([
      signUp("heist-pick-thief"),
      signUp("heist-pick-holder"),
      signUp("heist-pick-empty"),
    ]);
    const roundId = await startRound(thief, [holder, emptyHanded]);
    await forceHold(admin, holder.googleSub, "Lucky Sip");

    // Not holding Tea Heist yet: nothing is listed.
    const { data: before, error: beforeErr } = await thief.client.rpc("get_heist_targets", { p_round_id: roundId });
    expect(beforeErr).toBeNull();
    expect(before).toEqual([]);

    await forceHold(admin, thief.googleSub, "Tea Heist");
    const { data, error } = await thief.client.rpc("get_heist_targets", { p_round_id: roundId });
    expect(error).toBeNull();
    expect(data).toEqual([holder.googleSub]);
  });

  it("cast_spell_card rejects a Tea Heist on a target holding no card (RFB53) or with no target (RFB46)", async () => {
    const [thief, emptyHanded] = await Promise.all([signUp("heist-val-thief"), signUp("heist-val-empty")]);
    const roundId = await startRound(thief, [emptyHanded]);
    const heistInstance = await forceHold(admin, thief.googleSub, "Tea Heist");

    const { error: noCard } = await thief.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: emptyHanded.googleSub,
    });
    expect((noCard as { code?: string } | null)?.code).toBe("RFB53");

    const { error: noTarget } = await thief.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect((noTarget as { code?: string } | null)?.code).toBe("RFB46");

    // Both rejections rolled back: the thief still holds Tea Heist.
    expect(await instance(heistInstance)).toEqual({ location: "held", held_by_player: thief.googleSub });
  });

  it("never pins a pending_swap card -- only the victim's held one", async () => {
    const [thief, victim] = await Promise.all([signUp("heist-pin-thief"), signUp("heist-pin-victim")]);
    const roundId = await startRound(thief, [victim]);
    await forceHold(admin, thief.googleSub, "Tea Heist");
    // Park a keep-or-swap draw first (one held card per player), then hold.
    const parked = await forceHold(admin, victim.googleSub, "Tannin Tantrum");
    await admin.from("spell_deck_instances").update({ location: "pending_swap" }).eq("id", parked);
    const held = await forceHold(admin, victim.googleSub, "Lucky Sip");

    const { data: castId, error } = await thief.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: victim.googleSub,
    });
    expect(error).toBeNull();
    const { data: row } = await admin.from("spell_casts").select("cast_inputs").eq("id", castId).single();
    expect((row!.cast_inputs as { stolen_instance_id: string }).stolen_instance_id).toBe(held);
  });

  // ==========================================================================
  // Resolution outcomes
  // ==========================================================================

  // ==========================================================================
  // Replay
  // ==========================================================================
});
