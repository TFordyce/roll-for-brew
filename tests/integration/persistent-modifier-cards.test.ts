import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Exercises the three durable
// persistent-modifier cards un-benched by supabase/migrations/
// 0088_persistent_modifier_cards.sql (issue #342, child of spec #302):
//
//   * Chai-nge of Heart (Action, OPPONENT) — swaps the caster's and target's
//     effective modifiers for the rest of the day; whole-cast negation
//     reverts both on re-resolution.
//   * Tea-tally Spent (Reaction, SELF) — burns a clamped amount of the
//     caster's own modifier durably and adds the same amount to the cast
//     round's roll only; RFB44 with nothing to spend, RFB45 with no amount.
//   * Bitter Leech (Action, OPPONENT) — drains 1 modifier/round from target
//     to caster for the cast round + the next 2 rounds, then stops.
//
// Assertions are on externally observable outcomes: room_players.modifier
// (the log-derived cache), the get_modifier_breakdown reconciliation, and
// the resolve_round Resolution Trace / idempotence.

describe.skipIf(!hasAnonTestEnv)("persistent-modifier cards (issue #342)", () => {
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

  async function setBaseModifier(actor: Player, target: Player, delta: number) {
    if (delta === 0) return;
    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: delta,
      p_reason: "issue #342 test baseline",
    });
    expect(error).toBeNull();
  }

  /** start_round; every `others` player declares in; returns the round id (still open). */
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

  async function closeRound(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  /**
   * resolve_round does not itself flip the round to resolved, but
   * _rr_effect_rounds_elapsed (Bitter Leech liveness) counts resolved rounds
   * — so a multi-round test must stamp each round resolved once it is done.
   */
  async function markResolved(roundId: string) {
    const { error } = await admin
      .from("rounds")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", roundId);
    expect(error).toBeNull();
  }

  // ==========================================================================
  // Chai-nge of Heart
  // ==========================================================================

  // ==========================================================================
  // Tea-tally Spent
  // ==========================================================================

  async function openWindow(caster: Player, roundId: string) {
    const { data, error } = await caster.client.rpc("open_reaction_window", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(error).toBeNull();
    expect((data as { is_closed: boolean }[])[0]!.is_closed).toBe(false);
  }

  it("Tea-tally Spent refuses a caster with nothing to spend (RFB44) and a missing amount (RFB45)", async () => {
    const caster = await signUp("teatally-err-caster");
    const other = await signUp("teatally-err-other");

    // RFB45: amount omitted (caster still has a positive modifier).
    await setBaseModifier(other, caster, 4);
    const r1 = await startRound(caster, [other]);
    const inst1 = await forceHold(admin, caster.googleSub, "Tea-tally Spent");
    await closeRound(caster, r1);
    await openWindow(caster, r1);
    const missing = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: r1,
      p_target_player_id: null,
      p_target_cast_id: null,
      p_spend_amount: null,
    });
    expect(missing.error?.code).toBe("RFB45");
    await admin
      .from("spell_deck_instances")
      .update({ location: "benched", held_by_player: null })
      .eq("id", inst1);

    // RFB44: caster at 0 effective modifier.
    await setBaseModifier(other, caster, -4); // back to 0
    await markResolved(r1);
    const r2 = await startRound(caster, [other]);
    await forceHold(admin, caster.googleSub, "Tea-tally Spent");
    await closeRound(caster, r2);
    await openWindow(caster, r2);
    const broke = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: r2,
      p_target_player_id: null,
      p_target_cast_id: null,
      p_spend_amount: 1,
    });
    expect(broke.error?.code).toBe("RFB44");
  });

  // ==========================================================================
  // Bitter Leech
  // ==========================================================================
});
