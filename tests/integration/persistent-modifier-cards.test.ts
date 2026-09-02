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

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  brewer_id: string | null;
  trace: {
    display_kind: string;
    target_player: string | null;
    before: { type: string; value: number | string | null };
    after: { type: string; value: number | string | null };
  }[];
};

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

  async function seedRoll(roundId: string, playerId: string, value: number, modifierSnapshot = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: modifierSnapshot,
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

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
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

  async function roomModifier(roomId: string, playerId: string) {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", roomId)
      .eq("player_id", playerId)
      .single();
    expect(error).toBeNull();
    return data!.modifier as number;
  }

  async function breakdown(client: SupabaseClient, playerId: string, roomId: string) {
    const { data, error } = await client
      .rpc("get_modifier_breakdown", { p_player_id: playerId, p_room_id: roomId })
      .single();
    expect(error).toBeNull();
    return data as { cups_made: number; adjustments: number; spell_effects: number };
  }

  /** cups_made + adjustments + spell_effects must equal room_players.modifier. */
  async function expectReconciled(client: SupabaseClient, player: Player) {
    const b = await breakdown(client, player.googleSub, player.roomId);
    expect(b.cups_made + b.adjustments + b.spell_effects).toBe(
      await roomModifier(player.roomId, player.googleSub),
    );
    return b;
  }

  // ==========================================================================
  // Chai-nge of Heart
  // ==========================================================================

  it("Chai-nge of Heart swaps the two effective modifiers rest-of-day and the breakdown reconciles", async () => {
    const caster = await signUp("chainge-caster");
    const target = await signUp("chainge-target");

    // Distinct effective modifiers going in: caster +2, target +7.
    await setBaseModifier(target, caster, 2);
    await setBaseModifier(caster, target, 7);

    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Chai-nge of Heart");
    const { data: castId, error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castErr).toBeNull();
    expect(castId).toBeTruthy();

    await closeRound(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 10, 2);
    await seedRoll(roundId, target.googleSub, 11, 7);

    await resolve(caster.client, roundId);

    // Effective modifiers have swapped.
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(7);
    expect(await roomModifier(target.roomId, target.googleSub)).toBe(2);

    const cb = await expectReconciled(caster.client, caster);
    expect(cb).toEqual({ cups_made: 0, adjustments: 2, spell_effects: 5 });
    const tb = await expectReconciled(target.client, target);
    expect(tb).toEqual({ cups_made: 0, adjustments: 7, spell_effects: -5 });

    // Sibling pair in the Cast Log, linked by source_cast_id, rounds_remaining null.
    const { data: rows } = await admin
      .from("spell_casts")
      .select("target_player_id, effect_kind, effect_params, cast_inputs, source_cast_id")
      .eq("round_id", roundId)
      .eq("effect_kind", "persistent_modifier_transfer");
    expect(rows).toHaveLength(2);
    const casterRow = rows!.find((r) => r.target_player_id === caster.googleSub)!;
    const targetRow = rows!.find((r) => r.target_player_id === target.googleSub)!;
    expect(casterRow.effect_params).toEqual({ delta: 5 });
    expect(targetRow.effect_params).toEqual({ delta: -5 });
    expect(casterRow.cast_inputs).toEqual({ caster_modifier: 2, target_modifier: 7 });
    expect(targetRow.source_cast_id).toBeTruthy();
    expect(casterRow.source_cast_id).toBeNull();
  });

  it("a second resolve_round leaves the Chai-nge swap and its Trace steps unchanged (idempotent)", async () => {
    const caster = await signUp("chainge-idem-caster");
    const target = await signUp("chainge-idem-target");
    await setBaseModifier(target, caster, 3);
    await setBaseModifier(caster, target, 8);

    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Chai-nge of Heart");
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: target.googleSub });
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 9, 3);
    await seedRoll(roundId, target.googleSub, 9, 8);

    const first = await resolve(caster.client, roundId);
    const second = await resolve(caster.client, roundId);

    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(8);
    expect(await roomModifier(target.roomId, target.googleSub)).toBe(3);
    const pmt = (o: ResolveOutcome) => o.trace.filter((s) => s.display_kind === "persistent_modifier_transfer");
    expect(pmt(second)).toEqual(pmt(first));
  });

  it("negating a Chai-nge cast reverts both sides on re-resolution", async () => {
    const caster = await signUp("chainge-neg-caster");
    const target = await signUp("chainge-neg-target");
    await setBaseModifier(target, caster, 4);
    await setBaseModifier(caster, target, 9);

    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Chai-nge of Heart");
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: target.googleSub });
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 9, 4);
    await seedRoll(roundId, target.googleSub, 9, 9);

    // First resolve: swap applies.
    await resolve(caster.client, roundId);
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(9);
    expect(await roomModifier(target.roomId, target.googleSub)).toBe(4);

    // A contested_negate lands on the Chai-nge cast group (both sibling rows
    // share the card instance, so Phase 1 negates the pair).
    const { data: anchor } = await admin
      .from("spell_casts")
      .select("id, card_instance_id")
      .eq("round_id", roundId)
      .eq("effect_kind", "persistent_modifier_transfer")
      .is("source_cast_id", null)
      .single();
    const counterInstance = await forceHold(admin, target.googleSub, "Milky Brew");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", counterInstance);
    const { error: cErr } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: target.googleSub,
      card_instance_id: counterInstance,
      target_player_id: null,
      target_pending: false,
      effect_kind: "contested_negate",
      effect_params: {},
      parent_cast_id: anchor!.id,
      cast_inputs: { dc_d20: 20, dc: 5 },
    });
    expect(cErr).toBeNull();

    // Re-resolve: both caches revert to their pre-cast base.
    await resolve(caster.client, roundId);
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(4);
    expect(await roomModifier(target.roomId, target.googleSub)).toBe(9);
    expect((await expectReconciled(caster.client, caster)).spell_effects).toBe(0);
    expect((await expectReconciled(target.client, target)).spell_effects).toBe(0);
  });

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

  it("Tea-tally Spent burns a clamped amount durably and adds it to the cast round's roll only", async () => {
    const caster = await signUp("teatally-caster");
    const other = await signUp("teatally-other");
    await setBaseModifier(other, caster, 5);

    const roundId = await startRound(caster, [other]);
    await forceHold(admin, caster.googleSub, "Tea-tally Spent");
    await closeRound(caster, roundId);
    await openWindow(caster, roundId);

    const { data: castId, error: castErr } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
      p_spend_amount: 3,
    });
    expect(castErr).toBeNull();
    expect(castId).toBeTruthy();

    // One durable spend row + one round-scoped flat row, both on SELF.
    const { data: rows } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, target_player_id, cast_inputs")
      .eq("round_id", roundId)
      .in("effect_kind", ["persistent_modifier_spend", "flat_modifier"]);
    expect(rows).toHaveLength(2);
    const spend = rows!.find((r) => r.effect_kind === "persistent_modifier_spend")!;
    const flat = rows!.find((r) => r.effect_kind === "flat_modifier")!;
    expect(spend).toMatchObject({ effect_params: { delta: -3 }, target_player_id: caster.googleSub });
    expect(flat).toMatchObject({ effect_params: { delta: 3 }, target_player_id: caster.googleSub });
    expect(spend.cast_inputs).toEqual({ spend_amount: 3 });

    await seedRoll(roundId, caster.googleSub, 4, 5);
    await seedRoll(roundId, other.googleSub, 20, 0);
    const out = await resolve(caster.client, roundId);

    // Durable: 5 - 3 = 2, reconciled.
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(2);
    expect((await expectReconciled(caster.client, caster)).spell_effects).toBe(-3);

    // Round-scoped: the +3 flat composed into this round (5 -> 8).
    const flatStep = out.trace.find(
      (s) => s.display_kind === "flat_modifier" && s.target_player === caster.googleSub,
    )!;
    expect(flatStep.before).toEqual({ type: "modifier", value: 5 });
    expect(flatStep.after).toEqual({ type: "modifier", value: 8 });

    // A later round does not re-apply the flat, and the durable spend persists.
    await markResolved(roundId);
    const round2 = await startRound(caster, [other]);
    await closeRound(caster, round2);
    await seedRoll(round2, caster.googleSub, 4, 2);
    await seedRoll(round2, other.googleSub, 20, 0);
    const out2 = await resolve(caster.client, round2);
    expect(out2.trace.some((s) => s.display_kind === "flat_modifier")).toBe(false);
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(2);
  });

  it("Tea-tally Spent clamps the spend to the caster's current effective modifier", async () => {
    const caster = await signUp("teatally-clamp-caster");
    const other = await signUp("teatally-clamp-other");
    await setBaseModifier(other, caster, 2);

    const roundId = await startRound(caster, [other]);
    await forceHold(admin, caster.googleSub, "Tea-tally Spent");
    await closeRound(caster, roundId);
    await openWindow(caster, roundId);
    await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
      p_spend_amount: 10,
    });

    const { data: spend } = await admin
      .from("spell_casts")
      .select("effect_params, cast_inputs")
      .eq("round_id", roundId)
      .eq("effect_kind", "persistent_modifier_spend")
      .single();
    expect(spend!.effect_params).toEqual({ delta: -2 });
    expect(spend!.cast_inputs).toEqual({ spend_amount: 2 });

    await seedRoll(roundId, caster.googleSub, 4, 2);
    await seedRoll(roundId, other.googleSub, 20, 0);
    await resolve(caster.client, roundId);
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(0);
  });

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

  it("Bitter Leech drains 1 modifier/round from target to caster for the cast round + next 2, then stops", async () => {
    const caster = await signUp("leech-caster");
    const victim = await signUp("leech-victim");

    // Round 1 — cast Bitter Leech pre-roll.
    const r1 = await startRound(caster, [victim]);
    await forceHold(admin, caster.googleSub, "Bitter Leech");
    const { error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_target_player_id: victim.googleSub,
    });
    expect(castErr).toBeNull();
    await closeRound(caster, r1);
    await seedRoll(r1, caster.googleSub, 10, 0);
    await seedRoll(r1, victim.googleSub, 11, 0);
    await resolve(caster.client, r1);

    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(1);
    expect(await roomModifier(victim.roomId, victim.googleSub)).toBe(-1);
    await expectReconciled(caster.client, caster);
    await expectReconciled(victim.client, victim);
    await markResolved(r1);

    // Rounds 2 and 3 — the drain keeps ticking.
    for (const [expectCaster, expectVictim] of [
      [2, -2],
      [3, -3],
    ] as const) {
      const rn = await startRound(caster, [victim]);
      await closeRound(caster, rn);
      await seedRoll(rn, caster.googleSub, 10, 0);
      await seedRoll(rn, victim.googleSub, 11, 0);
      await resolve(caster.client, rn);
      expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(expectCaster);
      expect(await roomModifier(victim.roomId, victim.googleSub)).toBe(expectVictim);
      await markResolved(rn);
    }

    // Round 4 — effect expired (duration 3: cast round + 2), no further drain.
    const r4 = await startRound(caster, [victim]);
    await closeRound(caster, r4);
    await seedRoll(r4, caster.googleSub, 10, 0);
    await seedRoll(r4, victim.googleSub, 11, 0);
    await resolve(caster.client, r4);
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(3);
    expect(await roomModifier(victim.roomId, victim.googleSub)).toBe(-3);
    const { data: r4Ticks } = await admin
      .from("spell_casts")
      .select("id")
      .eq("round_id", r4)
      .contains("cast_inputs", { bitter_leech_tick: true });
    expect(r4Ticks).toHaveLength(0);
  });

  it("Bitter Leech tick synthesis is idempotent — a second resolve adds no rows and no steps", async () => {
    const caster = await signUp("leech-idem-caster");
    const victim = await signUp("leech-idem-victim");

    const r1 = await startRound(caster, [victim]);
    await forceHold(admin, caster.googleSub, "Bitter Leech");
    await caster.client.rpc("cast_spell_card", { p_round_id: r1, p_target_player_id: victim.googleSub });
    await closeRound(caster, r1);
    await seedRoll(r1, caster.googleSub, 10, 0);
    await seedRoll(r1, victim.googleSub, 11, 0);

    const first = await resolve(caster.client, r1);
    const second = await resolve(caster.client, r1);

    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(1);
    expect(await roomModifier(victim.roomId, victim.googleSub)).toBe(-1);

    const { data: ticks } = await admin
      .from("spell_casts")
      .select("id")
      .eq("round_id", r1)
      .contains("cast_inputs", { bitter_leech_tick: true });
    expect(ticks).toHaveLength(2); // one -1 / +1 pair, not doubled

    const pmt = (o: ResolveOutcome) => o.trace.filter((s) => s.display_kind === "persistent_modifier_transfer");
    expect(pmt(second)).toEqual(pmt(first));
  });
});
