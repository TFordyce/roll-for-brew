import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Exercises the authoritative layer-0
// resolver resolve_round(uuid) (supabase/migrations/
// 0078_resolve_round_authoritative.sql, issue #305) directly: seed a round's
// rolls and Cast Log, call resolve_round(uuid), and assert the brewer it
// picks, the Resolution Trace it emits, and its idempotence. Asserts on
// externally observable outcomes only (spec section: Testing Decisions).

type TraceStep = {
  index: number;
  display_kind: string;
  source_cast: {
    cast_id: string | null;
    active_effect_id: string | null;
    card_name: string | null;
    caster_player_id: string | null;
  };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: "applied" | "no-op";
  negated?: boolean;
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  layer: number;
  brewer_id: string | null;
  brewer_source: string | null;
  tied_player_ids: string[] | null;
  cups_made: number;
  no_modifier_gain: boolean;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("resolve_round(uuid): modifier composition, brewer selection, Trace", () => {
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

  async function seedRoll(roundId: string, playerId: string, value: number, modifierSnapshot = 0, layer = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer,
      value,
      input_mode: "manual",
      modifier_snapshot: modifierSnapshot,
    });
    expect(error).toBeNull();
  }

  /**
   * Forces the given player to hold `donorCard` (any Action card with no
   * duration) purely to obtain a valid spell_deck_instances id, then writes
   * a spell_casts row directly with the exact effect_kind / effect_params /
   * target we want — decoupling the test from any one catalog card's
   * mechanics.
   */
  async function seedCast(
    roundId: string,
    casterId: string,
    donorCard: string,
    row: {
      effectKind: string;
      effectParams: Record<string, unknown>;
      targetPlayerId: string | null;
      reactionWindowId?: string;
      castInputs?: Record<string, unknown>;
      parentCastId?: string;
    },
  ) {
    const instanceId = await forceHold(admin, casterId, donorCard);
    // Return it to the deck immediately — the cast row is what matters.
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);

    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: casterId,
        card_instance_id: instanceId,
        target_player_id: row.targetPlayerId,
        target_pending: false,
        effect_kind: row.effectKind,
        effect_params: row.effectParams,
        reaction_window_id: row.reactionWindowId ?? null,
        cast_inputs: row.castInputs ?? null,
        parent_cast_id: row.parentCastId ?? null,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function openWindow(roundId: string) {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** start_round + declare all others + close_round; returns the round id. */
  async function openAndCloseRound(starter: Awaited<ReturnType<typeof signUp>>, others: Awaited<ReturnType<typeof signUp>>[]) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    const { error: cErr } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(cErr).toBeNull();
    return roundId as string;
  }

  // resolve_round / advance_round_layer are granted to `authenticated`, not
  // `service_role` — so drive them through a signed-in participant's client,
  // the same way the app does, not the RLS-bypassing admin client.
  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  it("a zero-cast round picks the lowest roll+modifier and emits an empty Trace", async () => {
    const p1 = await signUp("rr-nocast-1");
    const p2 = await signUp("rr-nocast-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 15);

    const out = await resolve(p1.client, roundId);

    expect(out).toMatchObject({
      outcome: "brewer",
      layer: 0,
      brewer_id: p1.googleSub,
      brewer_source: "default",
      cups_made: 2,
      no_modifier_gain: false,
      trace: [],
    });

    const { data: round } = await admin
      .from("rounds")
      .select("resolution_trace, status")
      .eq("id", roundId)
      .single();
    expect(round!.resolution_trace).toEqual([]);
    // resolve_round(uuid) does NOT itself flip the round to resolved.
    expect(round!.status).toBe("closed");
  });

  it("a flat_modifier cast composes into the pick and shows as a Trace step", async () => {
    const p1 = await signUp("rr-flat-1");
    const p2 = await signUp("rr-flat-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    // +10 on p1: composed total 15 now loses to p2's untouched 12.
    const castId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 10 },
      targetPlayerId: p1.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.outcome).toBe("brewer");
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace).toHaveLength(1);
    const step = out.trace[0]!;
    expect(step).toMatchObject({
      index: 0,
      display_kind: "flat_modifier",
      target_player: p1.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 10 },
      outcome: "applied",
    });
    expect(step.source_cast.cast_id).toBe(castId);
    expect(step.source_cast.card_name).toBe("Lucky Sip");
  });

  it("a modifier_multiplier scales the persistent snapshot, not the roll", async () => {
    const p1 = await signUp("rr-mult-1");
    const p2 = await signUp("rr-mult-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // p1: roll 5, snapshot 4 -> raw total 9 (would lose to p2's 8).
    await seedRoll(roundId, p1.googleSub, 5, 4);
    await seedRoll(roundId, p2.googleSub, 8, 0);
    // x0.5 on p1 -> composed 2 -> total 7 -> p1 now wins.
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "modifier_multiplier",
      effectParams: { multiplier: 0.5 },
      targetPlayerId: p1.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.trace[0]).toMatchObject({
      display_kind: "modifier_multiplier",
      before: { type: "modifier", value: 4 },
      after: { type: "modifier", value: 2 },
    });
  });

  it("set_modifier is absolute — it ignores a sibling flat effect and two sets resolve to the last by seq", async () => {
    const p1 = await signUp("rr-set-1");
    const p2 = await signUp("rr-set-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 10);
    await seedRoll(roundId, p2.googleSub, 4, 0);
    // A flat +100 AND set 3 AND set 0 on p1 (in that insert / seq order):
    // set wins over flat, and the LAST set (0) wins over the first (3).
    await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 100 },
      targetPlayerId: p1.googleSub,
    });
    await seedCast(roundId, p1.googleSub, "Milky Brew", {
      effectKind: "set_modifier",
      effectParams: { value: 3 },
      targetPlayerId: p1.googleSub,
    });
    await seedCast(roundId, p1.googleSub, "Caffeinated Focus", {
      effectKind: "set_modifier",
      effectParams: { value: 0 },
      targetPlayerId: p1.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    // p1 composed = 0 -> total 5; p2 total 4 -> p2 brews.
    expect(out.brewer_id).toBe(p2.googleSub);
    // Final step's running "after" is the composed total: 0, not 103.
    expect(out.trace.at(-1)!.after).toEqual({ type: "modifier", value: 0 });
  });

  it("lowest_gains_highest_modifier lifts the tied-lowest roller's composed modifier to the highest roller's", async () => {
    const p1 = await signUp("rr-lghm-1");
    const p2 = await signUp("rr-lghm-2");
    const p3 = await signUp("rr-lghm-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    // p1 lowest roll (2); p2 highest roll (18) with a +5 flat -> composed 5;
    // p3 rolls 3.
    await seedRoll(roundId, p1.googleSub, 2, 0);
    await seedRoll(roundId, p2.googleSub, 18, 0);
    await seedRoll(roundId, p3.googleSub, 3, 0);
    await seedCast(roundId, p2.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
    });
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p3.googleSub, "Fortune's Flavour", {
      effectKind: "lowest_gains_highest_modifier",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
    });

    const out = await resolve(p1.client, roundId);

    // Without LGHM p1 would brew on total 2. LGHM lifts p1's composed
    // modifier 0 -> 5, so p1's total becomes 7 and p3 (total 3) brews.
    expect(out.brewer_id).toBe(p3.googleSub);
    const lghmStep = out.trace.find((s) => s.display_kind === "lowest_gains_highest_modifier");
    expect(lghmStep).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 5 },
      outcome: "applied",
    });
  });

  it("tea_maker_override 'chosen' names the brewer regardless of the rolls", async () => {
    const p1 = await signUp("rr-tmo-chosen-1");
    const p2 = await signUp("rr-tmo-chosen-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5); // would brew by default
    await seedRoll(roundId, p2.googleSub, 15);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "chosen" },
      targetPlayerId: p2.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("tea_maker_override:chosen");
    expect(out.no_modifier_gain).toBe(false);
  });

  it("tea_maker_override 'highest_roll' picks the top roller", async () => {
    const p1 = await signUp("rr-tmo-hr-1");
    const p2 = await signUp("rr-tmo-hr-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 17);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "highest_roll" },
      targetPlayerId: null,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("tea_maker_override:highest_roll");
  });

  it("tea_maker_override 'highest_modifier' with no_modifier_gain picks the top persistent snapshot and suppresses the gain", async () => {
    const p1 = await signUp("rr-tmo-hm-1");
    const p2 = await signUp("rr-tmo-hm-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 8);
    await seedRoll(roundId, p2.googleSub, 5, 2);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "highest_modifier", no_modifier_gain: true },
      targetPlayerId: null,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.no_modifier_gain).toBe(true);
  });

  it("declared_number_tea_maker beats a tea_maker_override, and resolve_round only reads it (does not consume)", async () => {
    const p1 = await signUp("rr-decl-1");
    const p2 = await signUp("rr-decl-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 13);

    // A competing override that would name p1.
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "chosen" },
      targetPlayerId: p1.googleSub,
    });

    // Inscribed-Saucer-style declared number 13 (p2 rolled it).
    const donor = await forceHold(admin, p1.googleSub, "Six Sugars");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", donor);
    const { data: card } = await admin.from("spell_cards").select("id").eq("name", "Six Sugars").single();
    const { data: sae, error: saeErr } = await admin
      .from("spell_active_effects")
      .insert({
        room_id: p1.roomId,
        target_player_id: p1.googleSub,
        caster_id: p1.googleSub,
        card_id: card!.id,
        effect_kind: "declared_number_tea_maker",
        effect_params: { number: 13 },
        rounds_remaining: 9999,
      })
      .select("id")
      .single();
    expect(saeErr).toBeNull();

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("declared_number");

    // resolve_round is a pure read — burning the one-shot is the
    // orchestrator's job (applyLayerOutcome), so the effect is still here
    // and a second call is identical.
    const { data: after } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("id", sae!.id);
    expect(after).toEqual([{ id: sae!.id }]);

    const again = await resolve(p1.client, roundId);
    expect(again.brewer_id).toBe(p2.googleSub);
    expect(JSON.stringify(again.trace)).toBe(JSON.stringify(out.trace));
  });

  it("a tie returns the sorted tied roster and no brewer", async () => {
    const p1 = await signUp("rr-tie-1");
    const p2 = await signUp("rr-tie-2");
    const p3 = await signUp("rr-tie-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 15);

    const out = await resolve(p1.client, roundId);

    expect(out.outcome).toBe("tie");
    expect(out.brewer_id).toBeNull();
    expect(out.tied_player_ids).toEqual([p1.googleSub, p2.googleSub].sort());
  });

  it("a tie-break reroll layer (layer > 0) bypasses all spell logic", async () => {
    const p1 = await signUp("rr-layer-1");
    const p2 = await signUp("rr-layer-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // Tie layer 0, then advance to layer 1.
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    const { error: advErr } = await p1.client.rpc("advance_round_layer", {
      p_round_id: roundId,
      p_tied_player_ids: [p1.googleSub, p2.googleSub],
    });
    expect(advErr).toBeNull();
    await seedRoll(roundId, p1.googleSub, 7, 0, 1);
    await seedRoll(roundId, p2.googleSub, 3, 0, 1);
    // A flat effect that WOULD flip the pick if composed in.
    await seedCast(roundId, p2.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 100 },
      targetPlayerId: p2.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.layer).toBe(1);
    expect(out.brewer_id).toBe(p2.googleSub); // bare roll 3 < 7, effect ignored
    expect(out.trace).toEqual([]);
  });

  it("Phase 3 adopts the eager shim's recorded roll_transform, flip before swap (issue #306)", async () => {
    const p1 = await signUp("rr-rt-1");
    const p2 = await signUp("rr-rt-2");
    const p3 = await signUp("rr-rt-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    // Base rolls as originally rolled.
    await seedRoll(roundId, p1.googleSub, 2);
    await seedRoll(roundId, p2.googleSub, 20);
    await seedRoll(roundId, p3.googleSub, 10);
    const windowId = await openWindow(roundId);

    // roll_flip ran first (order 3): 21 - v for everyone.
    await seedCast(roundId, p2.googleSub, "Fortune's Flavour", {
      effectKind: "roll_flip",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
      castInputs: {
        roll_transform: {
          kind: "roll_flip",
          order: 3,
          players: [
            { player_id: p1.googleSub, before: 2, after: 19 },
            { player_id: p2.googleSub, before: 20, after: 1 },
            { player_id: p3.googleSub, before: 10, after: 11 },
          ],
        },
      },
    });
    // roll_swap ran second (order 4): swap post-flip highest (p1=19) and lowest (p2=1).
    await seedCast(roundId, p3.googleSub, "Fortune's Flavour", {
      effectKind: "roll_swap",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
      castInputs: {
        roll_transform: {
          kind: "roll_swap",
          order: 4,
          players: [
            { player_id: p1.googleSub, before: 19, after: 1 },
            { player_id: p2.googleSub, before: 1, after: 19 },
          ],
        },
      },
    });

    const out = await resolve(p1.client, roundId);

    // Final rolls after flip-then-swap: p1=1, p2=19, p3=11 -> p1 (lowest) brews.
    expect(out.outcome).toBe("brewer");
    expect(out.brewer_id).toBe(p1.googleSub);

    // p1's two Phase-3 steps: flip (2 -> 19) strictly before swap (19 -> 1).
    const p1Steps = out.trace.filter((s) => s.target_player === p1.googleSub && s.before.type === "roll");
    expect(p1Steps.map((s) => s.display_kind)).toEqual(["roll_flip", "roll_swap"]);
    expect(p1Steps[0]).toMatchObject({ before: { type: "roll", value: 2 }, after: { type: "roll", value: 19 } });
    expect(p1Steps[1]).toMatchObject({ before: { type: "roll", value: 19 }, after: { type: "roll", value: 1 } });
  });

  it("Phase 3 reproduces the final rolls purely from cast_inputs, with no dependence on the live rolls.value (issue #306)", async () => {
    const p1 = await signUp("rr-rt-indep-1");
    const p2 = await signUp("rr-rt-indep-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // rolls.value left DELIBERATELY stale: p1's row still says 18 (would win
    // outright), but the recorded forced_reroll says p1 actually rolled 1.
    await seedRoll(roundId, p1.googleSub, 18);
    await seedRoll(roundId, p2.googleSub, 5);
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p2.googleSub, "Fortune's Flavour", {
      effectKind: "forced_reroll",
      effectParams: {},
      targetPlayerId: p1.googleSub,
      reactionWindowId: windowId,
      castInputs: {
        roll_transform: {
          kind: "forced_reroll",
          order: 2,
          players: [{ player_id: p1.googleSub, before: 18, after: 1 }],
        },
      },
    });

    const out = await resolve(p1.client, roundId);

    // Adopted the recorded 1, not the stale 18 -> p1 brews.
    expect(out.brewer_id).toBe(p1.googleSub);
    const step = out.trace.find((s) => s.display_kind === "forced_reroll");
    expect(step).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "roll", value: 18 },
      after: { type: "roll", value: 1 },
      outcome: "applied",
    });
  });

  it("is idempotent: re-running over identical inputs yields the same outcome and Trace", async () => {
    const p1 = await signUp("rr-idem-1");
    const p2 = await signUp("rr-idem-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 3);
    await seedRoll(roundId, p2.googleSub, 12);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "modifier_multiplier",
      effectParams: { multiplier: 2 },
      targetPlayerId: p1.googleSub,
    });

    const first = await resolve(p1.client, roundId);
    const second = await resolve(p1.client, roundId);

    expect(second.brewer_id).toBe(first.brewer_id);
    expect(second.outcome).toBe(first.outcome);
    expect(JSON.stringify(second.trace)).toBe(JSON.stringify(first.trace));
  });

  // ----------------------------------------------------------------------
  // Phase 1: Cast-Log resolution — contested_negate / redirect / recursive
  // counter chains, all derived from recorded cast_inputs (issue #307).
  // ----------------------------------------------------------------------

  it("a succeeded contested_negate suppresses the whole victim cast group and marks it negated", async () => {
    const p1 = await signUp("rr-neg-1");
    const p2 = await signUp("rr-neg-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    // +10 on p1 would push p1's total to 15 and hand the brew to p2 (12).
    const victimId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 10 },
      targetPlayerId: p1.googleSub,
    });
    // p2 counters it and wins the contest (recorded d20 15 >= dc 5).
    const counterId = await seedCast(roundId, p2.googleSub, "Milky Brew", {
      effectKind: "contested_negate",
      effectParams: {},
      targetPlayerId: null,
      parentCastId: victimId,
      castInputs: { dc_d20: 15, dc: 5 },
    });

    const out = await resolve(p1.client, roundId);

    // Victim effect gone -> p1 back to a bare 5 and brews.
    expect(out.outcome).toBe("brewer");
    expect(out.brewer_id).toBe(p1.googleSub);

    // spell_casts.negated after resolve equals the recursive derivation.
    const { data: victim } = await admin
      .from("spell_casts").select("negated").eq("id", victimId).single();
    expect(victim!.negated).toBe(true);

    // Trace: a contested_negate outcome step (dc_d20 is never its own step).
    const negStep = out.trace.find((s) => s.display_kind === "contested_negate");
    expect(negStep).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "status", value: "cast" },
      after: { type: "status", value: "negated target" },
      outcome: "applied",
    });
    expect(negStep!.source_cast.cast_id).toBe(counterId);
    expect(negStep!.source_cast.caster_player_id).toBe(p2.googleSub);

    // Struck-through no-op step for the negated victim group.
    const struck = out.trace.find((s) => s.negated === true);
    expect(struck).toMatchObject({
      display_kind: "flat_modifier",
      target_player: p1.googleSub,
      before: { type: "status", value: "negated" },
      after: { type: "status", value: "negated" },
      outcome: "no-op",
    });
    // The suppressed effect never becomes a modifier step.
    expect(out.trace.some((s) => s.before.type === "modifier")).toBe(false);
  });

  it("a failed contested_negate leaves the victim cast to compose, and reads as a no-op step", async () => {
    const p1 = await signUp("rr-negfail-1");
    const p2 = await signUp("rr-negfail-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const victimId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 10 },
      targetPlayerId: p1.googleSub,
    });
    // Contest lost: recorded d20 3 < dc 5.
    await seedCast(roundId, p2.googleSub, "Milky Brew", {
      effectKind: "contested_negate",
      effectParams: {},
      targetPlayerId: null,
      parentCastId: victimId,
      castInputs: { dc_d20: 3, dc: 5 },
    });

    const out = await resolve(p1.client, roundId);

    // +10 still lands -> p1 total 15 -> p2 (12) brews.
    expect(out.brewer_id).toBe(p2.googleSub);
    const { data: victim } = await admin
      .from("spell_casts").select("negated").eq("id", victimId).single();
    expect(victim!.negated).toBe(false);

    const negStep = out.trace.find((s) => s.display_kind === "contested_negate");
    expect(negStep).toMatchObject({
      after: { type: "status", value: "no effect" },
      outcome: "no-op",
    });
    expect(out.trace.some((s) => s.negated === true)).toBe(false);
    // The victim modifier still composed.
    expect(out.trace.find((s) => s.display_kind === "flat_modifier")).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 10 },
    });
  });

  it("DC is tier-derived from the victim card unless effect_params.dc (recorded in cast_inputs) overrides it", async () => {
    const p1 = await signUp("rr-dc-1");
    const p2 = await signUp("rr-dc-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);

    // Two independent rare-card flat +10 casts on p1, each its own cast group
    // (distinct donor card => distinct card_instance_id).
    const victimA = await seedCast(roundId, p1.googleSub, "Milky Brew", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });
    const victimB = await seedCast(roundId, p1.googleSub, "Tea Leaf", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });

    // Counter A: recorded d20 4, no dc -> checked against rare-tier default 5 -> FAILS.
    await seedCast(roundId, p2.googleSub, "Slipped Spoon", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: victimA, castInputs: { dc_d20: 4 },
    });
    // Counter B: same d20 4 but dc override 2 -> SUCCEEDS.
    await seedCast(roundId, p2.googleSub, "Steady Hand", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: victimB, castInputs: { dc_d20: 4, dc: 2 },
    });

    await resolve(p1.client, roundId);

    const { data: rows } = await admin
      .from("spell_casts").select("id, negated").in("id", [victimA, victimB]);
    const byId = Object.fromEntries(rows!.map((r) => [r.id, r.negated]));
    expect(byId[victimA]).toBe(false); // rare-tier default DC 5 not met by 4
    expect(byId[victimB]).toBe(true);  // dc override 2 met by 4
  });

  it("counter-of-counter (depth 2): the counter is itself countered, so the original victim effect applies", async () => {
    const p1 = await signUp("rr-coc2-1");
    const p2 = await signUp("rr-coc2-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const victimId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });
    // C1: p2 negates the victim.
    const c1 = await seedCast(roundId, p2.googleSub, "Bes-Tea", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: victimId, castInputs: { dc_d20: 15, dc: 5 },
    });
    // C2: p1 negates C1.
    await seedCast(roundId, p1.googleSub, "Brewer's Blessing", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: c1, castInputs: { dc_d20: 15, dc: 5 },
    });

    const out = await resolve(p1.client, roundId);

    // C1 countered -> victim +10 lands -> p1 total 15 -> p2 brews.
    expect(out.brewer_id).toBe(p2.googleSub);
    const { data: rows } = await admin
      .from("spell_casts").select("id, negated").in("id", [victimId, c1]);
    const byId = Object.fromEntries(rows!.map((r) => [r.id, r.negated]));
    expect(byId[victimId]).toBe(false); // original effect NOT negated
    expect(byId[c1]).toBe(true);        // the first counter WAS negated

    expect(out.trace.find((s) => s.display_kind === "flat_modifier")).toMatchObject({
      target_player: p1.googleSub,
      after: { type: "modifier", value: 10 },
    });
  });

  it("counter-of-counter-of-counter (depth 3): the top counter revives C1, re-negating the victim", async () => {
    const p1 = await signUp("rr-coc3-1");
    const p2 = await signUp("rr-coc3-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const victimId = await seedCast(roundId, p1.googleSub, "Cold Tea", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });
    const c1 = await seedCast(roundId, p2.googleSub, "Gambler's Infusion", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: victimId, castInputs: { dc_d20: 15, dc: 5 },
    });
    const c2 = await seedCast(roundId, p1.googleSub, "Last Drip", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: c1, castInputs: { dc_d20: 15, dc: 5 },
    });
    await seedCast(roundId, p2.googleSub, "Lesser Detox", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: c2, castInputs: { dc_d20: 15, dc: 5 },
    });

    const out = await resolve(p1.client, roundId);

    // C2 negated -> C1 lives -> victim negated -> p1 bare 5 -> p1 brews.
    expect(out.brewer_id).toBe(p1.googleSub);
    const { data: rows } = await admin
      .from("spell_casts").select("id, negated").in("id", [victimId, c1, c2]);
    const byId = Object.fromEntries(rows!.map((r) => [r.id, r.negated]));
    expect(byId[victimId]).toBe(true);
    expect(byId[c1]).toBe(false);
    expect(byId[c2]).toBe(true);
  });

  it("redirect retargets a modifier cast onto the original caster, from recorded state (no in-place UPDATE)", async () => {
    const p1 = await signUp("rr-redir-1");
    const p2 = await signUp("rr-redir-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 3);
    // p1 dumps set_modifier 100 on p2. Unredirected: p2 -> 103, p1 (10) brews.
    const victimId = await seedCast(roundId, p1.googleSub, "Milky Brew", {
      effectKind: "set_modifier", effectParams: { value: 100 }, targetPlayerId: p2.googleSub,
    });
    // p2 reflects it back onto p1 (the original caster).
    const redirectId = await seedCast(roundId, p2.googleSub, "Mug Mirror", {
      effectKind: "redirect", effectParams: {}, targetPlayerId: null,
      parentCastId: victimId,
    });

    const out = await resolve(p1.client, roundId);

    // Effect now lands on p1 -> p1 total 110, p2 bare 3 -> p2 brews.
    expect(out.brewer_id).toBe(p2.googleSub);

    const redirStep = out.trace.find((s) => s.display_kind === "redirect");
    expect(redirStep).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "target", value: p2.googleSub },
      after: { type: "target", value: p1.googleSub },
      outcome: "applied",
    });
    expect(redirStep!.source_cast.cast_id).toBe(redirectId);

    // The modifier bucketed onto p1, not p2.
    const modStep = out.trace.find((s) => s.display_kind === "set_modifier");
    expect(modStep).toMatchObject({
      target_player: p1.googleSub,
      after: { type: "modifier", value: 100 },
    });

    // redirected_to_cast_id cache points the victim at the redirect cast
    // (no in-place target_player_id mutation).
    const { data: victim } = await admin
      .from("spell_casts").select("redirected_to_cast_id, target_player_id").eq("id", victimId).single();
    expect(victim!.redirected_to_cast_id).toBe(redirectId);
    expect(victim!.target_player_id).toBe(p2.googleSub);
  });

  it("Phase 1 is idempotent: re-resolving a round with a counter chain yields an identical Trace", async () => {
    const p1 = await signUp("rr-negidem-1");
    const p2 = await signUp("rr-negidem-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const victimId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });
    await seedCast(roundId, p2.googleSub, "Milky Brew", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: victimId, castInputs: { dc_d20: 18, dc: 5 },
    });

    const first = await resolve(p1.client, roundId);
    const second = await resolve(p1.client, roundId);
    expect(second.brewer_id).toBe(first.brewer_id);
    expect(JSON.stringify(second.trace)).toBe(JSON.stringify(first.trace));
  });

  it("a negated forced_reroll unwinds to the recorded before value (issue #308)", async () => {
    const p1 = await signUp("rr-negrt-1");
    const p2 = await signUp("rr-negrt-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3);
    await seedRoll(roundId, p2.googleSub, 8);
    const windowId = await openWindow(roundId);
    // p2 forces p1 to reroll 18 -> 1 (recorded). p1's rolls.value is left at
    // the post-reroll 1, exactly as the eager shim leaves it.
    const rerollId = await seedCast(roundId, p2.googleSub, "Fortune's Flavour", {
      effectKind: "forced_reroll", effectParams: {}, targetPlayerId: p1.googleSub,
      reactionWindowId: windowId,
      castInputs: {
        roll_transform: {
          kind: "forced_reroll", order: 2,
          players: [{ player_id: p1.googleSub, before: 18, after: 1 }],
        },
      },
    });
    await admin.from("rolls").update({ value: 1 }).eq("round_id", roundId).eq("player_id", p1.googleSub).eq("layer", 0);
    // p1 counters the reroll and wins (d20 15 >= dc 5).
    await seedCast(roundId, p1.googleSub, "Milky Brew", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: rerollId, castInputs: { dc_d20: 15, dc: 5 },
    });

    const out = await resolve(p1.client, roundId);

    // The reroll is unwound -> p1 back to 18, so p2 (8) is now the lowest.
    expect(out.brewer_id).toBe(p2.googleSub);
    // No surviving forced_reroll step for p1.
    expect(out.trace.some((s) => s.display_kind === "forced_reroll" && s.before.type === "roll")).toBe(false);
  });

  // ----------------------------------------------------------------------
  // Saving Steep natural-1 backfire (issue #308, spec §8).
  // ----------------------------------------------------------------------

  it("a nat-1 backfire leaves the victim to resolve and re-applies its flat_modifier onto the reactor, outcome 'backfired'", async () => {
    const p1 = await signUp("rr-bf-flat-1");
    const p2 = await signUp("rr-bf-flat-2");
    const p3 = await signUp("rr-bf-flat-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 5);
    await seedRoll(roundId, p3.googleSub, 5);
    // p1 buffs p3 by +10.
    const victimId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p3.googleSub,
    });
    // p2 (reactor) counters with Saving Steep and rolls a natural 1.
    const counterId = await seedCast(roundId, p2.googleSub, "Saving Steep", {
      effectKind: "contested_negate", effectParams: { dc: 10 }, targetPlayerId: null,
      parentCastId: victimId,
      castInputs: { dc_d20: 1, dc: 10, backfire: { transforms: [], dice_rolls: {} } },
    });

    const out = await resolve(p1.client, roundId);

    // Victim NOT negated -> p3 still +10 (total 15); backfire +10 on p2
    // (total 15); p1 untouched at 5 -> p1 brews.
    expect(out.brewer_id).toBe(p1.googleSub);
    const { data: victim } = await admin.from("spell_casts").select("negated").eq("id", victimId).single();
    expect(victim!.negated).toBe(false);

    const negStep = out.trace.find((s) => s.display_kind === "contested_negate");
    expect(negStep).toMatchObject({ outcome: "backfired" });
    expect((negStep as unknown as { dc_d20: number; dc: number }).dc_d20).toBe(1);
    expect((negStep as unknown as { dc: number }).dc).toBe(10);

    // p3's own +10 modifier step still there.
    expect(out.trace.find((s) => s.display_kind === "flat_modifier" && s.target_player === p3.googleSub))
      .toMatchObject({ after: { type: "modifier", value: 10 } });
    // A backfire +10 modifier step landed on the reactor p2.
    const bfStep = out.trace.find(
      (s) => s.display_kind === "flat_modifier" && s.target_player === p2.googleSub,
    ) as unknown as { after: { value: number }; backfire?: boolean };
    expect(bfStep.after.value).toBe(10);
    expect(bfStep.backfire).toBe(true);
    expect(negStep!.source_cast.cast_id).toBe(counterId);
  });

  it("a nat-1 backfire re-applies a disadvantage onto the reactor as a third-die-lowest roll step", async () => {
    const p1 = await signUp("rr-bf-dis-1");
    const p2 = await signUp("rr-bf-dis-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 15);
    // p1 casts disadvantage at p2 (no recorded roll_transform needed for the
    // test — the victim contributes nothing extra of its own).
    const victimId = await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "disadvantage", effectParams: {}, targetPlayerId: p2.googleSub,
    });
    // p2 counters with Saving Steep, nat 1: backfire draws two more d20 (2, 3).
    await seedCast(roundId, p2.googleSub, "Saving Steep", {
      effectKind: "contested_negate", effectParams: { dc: 10 }, targetPlayerId: null,
      parentCastId: victimId,
      castInputs: {
        dc_d20: 1, dc: 10,
        backfire: {
          transforms: [{ kind: "disadvantage", order: 1, extra_dice: [2, 3] }],
          dice_rolls: {},
        },
      },
    });

    const out = await resolve(p1.client, roundId);

    // p2's 15 vs the two backfire dice 2, 3 -> lowest 2. p1 (10) > p2 (2) -> p2 brews.
    expect(out.brewer_id).toBe(p2.googleSub);
    const bfRoll = out.trace.find(
      (s) => s.display_kind === "disadvantage" && s.target_player === p2.googleSub && s.before.type === "roll",
    ) as unknown as { before: { value: number }; after: { value: number }; backfire?: boolean };
    expect(bfRoll.before.value).toBe(15);
    expect(bfRoll.after.value).toBe(2);
    expect(bfRoll.backfire).toBe(true);
  });

  it("redirect on a multi-target countered cast moves only the reactor's own row; the other target still hits", async () => {
    const p1 = await signUp("rr-redir-multi-1");
    const p2 = await signUp("rr-redir-multi-2");
    const p3 = await signUp("rr-redir-multi-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 3);
    await seedRoll(roundId, p3.googleSub, 3);
    // p1 dumps a +100 flat on p2 as one row of a two-row cast group.
    const rowP2 = await seedCast(roundId, p1.googleSub, "Milky Brew", {
      effectKind: "flat_modifier", effectParams: { delta: 100 }, targetPlayerId: p2.googleSub,
    });
    const { data: rowP2full } = await admin
      .from("spell_casts").select("card_instance_id").eq("id", rowP2).single();
    // A sibling row of the SAME cast group hitting p3.
    const { data: rowP3full, error: sibErr } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId, caster_id: p1.googleSub,
        card_instance_id: rowP2full!.card_instance_id,
        target_player_id: p3.googleSub, target_pending: false,
        effect_kind: "flat_modifier", effect_params: { delta: 100 },
      })
      .select("id").single();
    expect(sibErr).toBeNull();
    // p2 reflects only its own exposure back onto the original caster p1.
    await seedCast(roundId, p2.googleSub, "Mug Mirror", {
      effectKind: "redirect", effectParams: {}, targetPlayerId: null,
      parentCastId: rowP2,
    });

    const out = await resolve(p1.client, roundId);

    // p2's row -> p1 (total 110); p3's row stays (total 103); p2 bare 3 -> p2 brews.
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.find((s) => s.display_kind === "flat_modifier" && s.target_player === p1.googleSub))
      .toMatchObject({ after: { type: "modifier", value: 100 } });
    expect(out.trace.find((s) => s.display_kind === "flat_modifier" && s.target_player === p3.googleSub))
      .toMatchObject({ after: { type: "modifier", value: 100 } });
    // p2 itself takes no modifier hit.
    expect(out.trace.some((s) => s.display_kind === "flat_modifier" && s.target_player === p2.googleSub)).toBe(false);
    void rowP3full;
  });

  it("Saving Steep is a live catalog card with a contested_negate {dc:10, backfire} effect and a deck instance", async () => {
    const { data: card } = await admin.from("spell_cards").select("id").eq("name", "Saving Steep").single();
    const { data: effects } = await admin
      .from("spell_card_effects").select("effect_kind, effect_params").eq("card_id", card!.id);
    expect(effects).toEqual([{ effect_kind: "contested_negate", effect_params: { dc: 10, backfire: true } }]);
    const { data: instances } = await admin
      .from("spell_deck_instances").select("location").eq("card_id", card!.id);
    expect(instances!.length).toBeGreaterThan(0);
    expect(instances!.every((i) => i.location !== "benched")).toBe(true);
  });

  it("Saving Steep {dc:10}: d20 >= 10 negates the whole victim group", async () => {
    const p1 = await signUp("rr-ss-neg-1");
    const p2 = await signUp("rr-ss-neg-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const victimId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });
    await seedCast(roundId, p2.googleSub, "Milky Brew", {
      effectKind: "contested_negate", effectParams: { dc: 10, backfire: true }, targetPlayerId: null,
      parentCastId: victimId, castInputs: { dc_d20: 11, dc: 10 },
    });

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p1.googleSub); // +10 gone -> p1 back to a bare 5
    const { data: victim } = await admin.from("spell_casts").select("negated").eq("id", victimId).single();
    expect(victim!.negated).toBe(true);
    expect(out.trace.find((s) => s.display_kind === "contested_negate")).toMatchObject({ outcome: "applied" });
  });

  it("Saving Steep {dc:10}: a 2-9 roll loses the contest — victim composes, no backfire, no-op step", async () => {
    const p1 = await signUp("rr-ss-loss-1");
    const p2 = await signUp("rr-ss-loss-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const victimId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });
    // A recorded 7: below the dc:10 override, above nat 1 -> plain contest loss.
    await seedCast(roundId, p2.googleSub, "Milky Brew", {
      effectKind: "contested_negate", effectParams: { dc: 10, backfire: true }, targetPlayerId: null,
      parentCastId: victimId, castInputs: { dc_d20: 7, dc: 10 },
    });

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p2.googleSub); // +10 still lands -> p1 total 15
    const { data: victim } = await admin.from("spell_casts").select("negated").eq("id", victimId).single();
    expect(victim!.negated).toBe(false);
    const negStep = out.trace.find((s) => s.display_kind === "contested_negate");
    expect(negStep).toMatchObject({ outcome: "no-op", after: { type: "status", value: "no effect" } });
    expect((negStep as unknown as { dc_d20: number; dc: number }).dc_d20).toBe(7);
    expect((negStep as unknown as { dc: number }).dc).toBe(10);
    expect(out.trace.some((s) => (s as unknown as { backfire?: boolean }).backfire)).toBe(false);
  });

  it("a counter with no recorded backfire payload never backfires on a nat 1 (Tannin Tantrum path)", async () => {
    const p1 = await signUp("rr-tt-nat1-1");
    const p2 = await signUp("rr-tt-nat1-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const victimId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });
    // Tier-derived dc (common = 2), recorded nat 1, and — crucially — no
    // `backfire` key in cast_inputs (cast_reaction_spell_card only writes it
    // when effect_params.backfire is set, i.e. only for Saving Steep).
    await seedCast(roundId, p2.googleSub, "Milky Brew", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: victimId, castInputs: { dc_d20: 1, dc: 2 },
    });

    const out = await resolve(p1.client, roundId);

    // Plain contest loss: +10 lands, p2 brews; nothing re-applied onto p2.
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.find((s) => s.display_kind === "contested_negate")).toMatchObject({ outcome: "no-op" });
    expect(out.trace.some((s) => (s as unknown as { backfire?: boolean }).backfire)).toBe(false);
    expect(out.trace.some((s) => s.target_player === p2.googleSub && s.before.type === "modifier")).toBe(false);
  });

  it("a negated advantage unwinds to the recorded before value (issue #308)", async () => {
    const p1 = await signUp("rr-negadv-1");
    const p2 = await signUp("rr-negadv-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 2);
    await seedRoll(roundId, p2.googleSub, 8);
    const windowId = await openWindow(roundId);
    // p1 was given advantage: rolled 3 and 19, kept 19 (recorded). rolls.value
    // sits at the kept 19.
    const advId = await seedCast(roundId, p1.googleSub, "Fortune's Flavour", {
      effectKind: "advantage", effectParams: {}, targetPlayerId: p1.googleSub,
      reactionWindowId: windowId,
      castInputs: {
        roll_transform: {
          kind: "advantage", order: 1, cancelled: false, dice: [3, 19],
          players: [{ player_id: p1.googleSub, before: 3, after: 19 }],
        },
      },
    });
    await admin.from("rolls").update({ value: 19 }).eq("round_id", roundId).eq("player_id", p1.googleSub).eq("layer", 0);
    await seedCast(roundId, p2.googleSub, "Milky Brew", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: advId, castInputs: { dc_d20: 15, dc: 5 },
    });

    const out = await resolve(p1.client, roundId);

    // Advantage unwound -> p1 back to the recorded 3, now the lowest.
    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.trace.some((s) => s.display_kind === "advantage" && s.before.type === "roll")).toBe(false);
  });

  it("negating one row of a compound cast negates every row of the group (issue #308)", async () => {
    const p1 = await signUp("rr-compound-neg-1");
    const p2 = await signUp("rr-compound-neg-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 4);
    await seedRoll(roundId, p2.googleSub, 12);
    // Two rows of ONE cast group (shared card_instance_id): +10 on p1, +5 on p1.
    const rowA = await seedCast(roundId, p1.googleSub, "Slipped Spoon", {
      effectKind: "flat_modifier", effectParams: { delta: 10 }, targetPlayerId: p1.googleSub,
    });
    const { data: rowAfull } = await admin
      .from("spell_casts").select("card_instance_id").eq("id", rowA).single();
    const { data: rowB, error: bErr } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId, caster_id: p1.googleSub,
        card_instance_id: rowAfull!.card_instance_id,
        target_player_id: p1.googleSub, target_pending: false,
        effect_kind: "flat_modifier", effect_params: { delta: 5 },
      })
      .select("id").single();
    expect(bErr).toBeNull();
    // Counter targets only row A.
    await seedCast(roundId, p2.googleSub, "Milky Brew", {
      effectKind: "contested_negate", effectParams: {}, targetPlayerId: null,
      parentCastId: rowA, castInputs: { dc_d20: 15, dc: 5 },
    });

    const out = await resolve(p1.client, roundId);

    // BOTH +10 and +5 suppressed -> p1 bare 4, brews.
    expect(out.brewer_id).toBe(p1.googleSub);
    const { data: rows } = await admin
      .from("spell_casts").select("id, negated").in("id", [rowA, rowB!.id]);
    expect(rows!.every((r) => r.negated === true)).toBe(true);
    expect(out.trace.some((s) => s.before.type === "modifier")).toBe(false);
  });
});
