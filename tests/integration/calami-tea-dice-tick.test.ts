import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Exercises Calami-Tea's per-round
// dice tick (issue #289, spec #302 Tier B primitive 6 / migration
// 0100_calami_tea_per_round_dice_tick.sql):
//
//   * Casting Calami-Tea (CHOSEN_PLAYERS) emits one per_round_dice_tick anchor
//     cast per target + one spell_active_effects projection row (duration 3).
//   * resolve_round Phase 3-pre synthesises one child cast per target each
//     round the effect is live, carrying a freshly-rolled 1d4 in
//     cast_inputs.roll_transform; the Phase 3 walk subtracts it from the roll
//     (floor 1) and emits a `dice_tick` Trace step.
//   * The tick fires for the cast round + the next 2, then stops.
//   * A re-resolve reuses the recorded die (no re-roll, no extra rows).
//   * A negative-polarity roll-domain ward (Cast-Iron Kettle) on a target
//     blocks that round's tick: the synth cast goes in negated and a `warded`
//     step is emitted instead.

type TraceStep = {
  display_kind: string;
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome?: string | null;
  ward_card_name?: string | null;
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  brewer_id: string | null;
  tied_player_ids: string[] | null;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("Calami-Tea per-round dice tick (issue #289)", () => {
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

  async function closeRound(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function seedRoll(roundId: string, playerId: string, value: number) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: 0,
    });
    expect(error).toBeNull();
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  /**
   * _rr_active_effects_as_of (tick liveness) counts resolved rounds since the
   * anchor cast, so a multi-round test must stamp each round resolved.
   */
  async function markResolved(roundId: string) {
    const { error } = await admin
      .from("rounds")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", roundId);
    expect(error).toBeNull();
  }

  async function tickCasts(roundId: string) {
    const { data, error } = await admin
      .from("spell_casts")
      .select("id, target_player_id, effect_kind, effect_params, negated")
      .eq("round_id", roundId)
      .contains("cast_inputs", { dice_tick: true });
    expect(error).toBeNull();
    return (data ?? []) as {
      id: string;
      target_player_id: string;
      effect_kind: string;
      effect_params: { die: number; sign: number; rolled: number };
      negated: boolean;
    }[];
  }

  function diceTickStep(out: ResolveOutcome, victimId: string) {
    return out.trace.find((s) => s.display_kind === "dice_tick" && s.target_player === victimId);
  }

  // ==========================================================================

  it("casting Calami-Tea projects a per_round_dice_tick effect and each round subtracts a fresh 1d4 from the roll", async () => {
    const caster = await signUp("calami-caster");
    const victim = await signUp("calami-victim");

    // Round 1 — cast pre-roll on the victim.
    const r1 = await startRound(caster, [victim]);
    await forceHold(admin, caster.googleSub, "Calami-Tea");
    const { error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_chosen_player_ids: [victim.googleSub],
    });
    expect(castErr).toBeNull();

    // Anchor cast + projection row.
    const { data: anchor } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, cast_inputs")
      .eq("round_id", r1)
      .eq("effect_kind", "per_round_dice_tick");
    expect(anchor).toHaveLength(1);
    expect(anchor![0]!.effect_params).toMatchObject({ die: 4, sign: -1, max_targets: 3 });

    const { data: effects } = await admin
      .from("spell_active_effects")
      .select("effect_kind, target_player_id, rounds_remaining")
      .eq("room_id", victim.roomId)
      .eq("effect_kind", "per_round_dice_tick");
    expect(effects).toEqual([
      { effect_kind: "per_round_dice_tick", target_player_id: victim.googleSub, rounds_remaining: 3 },
    ]);

    // Resolve round 1 — the tick fires on the cast round too.
    await closeRound(caster, r1);
    await seedRoll(r1, caster.googleSub, 5);
    await seedRoll(r1, victim.googleSub, 18);
    const out1 = await resolve(caster.client, r1);

    const ticks1 = await tickCasts(r1);
    expect(ticks1).toHaveLength(1);
    expect(ticks1[0]!.target_player_id).toBe(victim.googleSub);
    expect(ticks1[0]!.negated).toBe(false);
    const rolled1 = ticks1[0]!.effect_params.rolled;
    expect(rolled1).toBeGreaterThanOrEqual(1);
    expect(rolled1).toBeLessThanOrEqual(4);

    const step1 = diceTickStep(out1, victim.googleSub);
    expect(step1).toBeDefined();
    expect(step1!.before).toEqual({ type: "roll", value: 18 });
    expect(step1!.after).toEqual({ type: "roll", value: Math.max(1, 18 - rolled1) });

    await markResolved(r1);

    // Rounds 2 and 3 — a fresh die each round, no new cast needed.
    const laterRounds: string[] = [];
    for (const rNo of [2, 3]) {
      const rn = await startRound(caster, [victim]);
      laterRounds.push(rn);
      await closeRound(caster, rn);
      await seedRoll(rn, caster.googleSub, 5);
      await seedRoll(rn, victim.googleSub, 15);
      const outN = await resolve(caster.client, rn);

      const ticksN = await tickCasts(rn);
      expect(ticksN, `round ${rNo} tick`).toHaveLength(1);
      const rolledN = ticksN[0]!.effect_params.rolled;
      expect(rolledN).toBeGreaterThanOrEqual(1);
      expect(rolledN).toBeLessThanOrEqual(4);

      const stepN = diceTickStep(outN, victim.googleSub);
      expect(stepN, `round ${rNo} dice_tick step`).toBeDefined();
      expect(stepN!.after).toEqual({ type: "roll", value: Math.max(1, 15 - rolledN) });

      await markResolved(rn);
    }

    // Round 4 — duration 3 spent (cast round + 2), no further tick.
    const r4 = await startRound(caster, [victim]);
    await closeRound(caster, r4);
    await seedRoll(r4, caster.googleSub, 5);
    await seedRoll(r4, victim.googleSub, 15);
    const out4 = await resolve(caster.client, r4);

    expect(await tickCasts(r4)).toHaveLength(0);
    expect(diceTickStep(out4, victim.googleSub)).toBeUndefined();

    // Ordered teardown: the synthesised tick rows in rounds 2-4 carry
    // source_cast_id -> the round-1 anchor cast (a NO ACTION self-FK on
    // spell_casts), so the later rounds must be dropped before round 1.
    // cleanup.run() deletes tracked rounds concurrently and cannot guarantee
    // that order.
    for (const r of [r4, ...laterRounds.reverse(), r1]) {
      const { error } = await admin.from("rounds").delete().eq("id", r);
      expect(error).toBeNull();
    }
  });

  it("a re-resolve reuses the recorded die — no extra rows, identical Trace step", async () => {
    const caster = await signUp("calami-idem-caster");
    const victim = await signUp("calami-idem-victim");

    const r1 = await startRound(caster, [victim]);
    await forceHold(admin, caster.googleSub, "Calami-Tea");
    await caster.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_chosen_player_ids: [victim.googleSub],
    });
    await closeRound(caster, r1);
    await seedRoll(r1, caster.googleSub, 5);
    await seedRoll(r1, victim.googleSub, 12);

    const first = await resolve(caster.client, r1);
    const second = await resolve(caster.client, r1);

    const ticks = await tickCasts(r1);
    expect(ticks).toHaveLength(1); // not doubled

    const tickSteps = (o: ResolveOutcome) => o.trace.filter((s) => s.display_kind === "dice_tick");
    expect(tickSteps(second)).toEqual(tickSteps(first));
  });

  it("two chosen targets each get an independent fresh die in the same round", async () => {
    const caster = await signUp("calami-multi-caster");
    const v1 = await signUp("calami-multi-v1");
    const v2 = await signUp("calami-multi-v2");

    const r1 = await startRound(caster, [v1, v2]);
    await forceHold(admin, caster.googleSub, "Calami-Tea");
    const { error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_chosen_player_ids: [v1.googleSub, v2.googleSub],
    });
    expect(castErr).toBeNull();

    // One anchor cast + one projection row per target.
    const { data: anchors } = await admin
      .from("spell_casts")
      .select("target_player_id")
      .eq("round_id", r1)
      .eq("effect_kind", "per_round_dice_tick");
    expect((anchors ?? []).map((a) => a.target_player_id).sort()).toEqual(
      [v1.googleSub, v2.googleSub].sort(),
    );

    await closeRound(caster, r1);
    await seedRoll(r1, caster.googleSub, 5);
    await seedRoll(r1, v1.googleSub, 17);
    await seedRoll(r1, v2.googleSub, 17);
    const out = await resolve(caster.client, r1);

    for (const v of [v1, v2]) {
      const step = diceTickStep(out, v.googleSub);
      expect(step, `dice_tick step for ${v.googleSub}`).toBeDefined();
      // after = 17 - rolled (before 17, so the floor-at-1 never bites here).
      expect(Number(step!.before.value)).toBe(17);
      const sub = 17 - Number(step!.after.value);
      expect(sub).toBeGreaterThanOrEqual(1);
      expect(sub).toBeLessThanOrEqual(4);
    }

    // Two distinct synth tick casts, one per target, each with its own die.
    const ticks = await tickCasts(r1);
    expect(ticks).toHaveLength(2);
    expect(ticks.map((t) => t.target_player_id).sort()).toEqual([v1.googleSub, v2.googleSub].sort());
    for (const t of ticks) {
      expect(t.effect_params.rolled).toBeGreaterThanOrEqual(1);
      expect(t.effect_params.rolled).toBeLessThanOrEqual(4);
    }
  });

  it("a negative-polarity roll-domain ward on a target blocks that round's tick with a warded step", async () => {
    const caster = await signUp("calami-ward-caster");
    const victim = await signUp("calami-ward-victim");

    await seedActiveEffect(admin, cleanup, {
      roomId: victim.roomId,
      targetPlayerId: victim.googleSub,
      casterId: caster.googleSub,
      cardName: "Cast-Iron Kettle",
      effectKind: "ward",
      effectParams: { polarity: ["negative"], domain: ["roll"] },
      roundsRemaining: 10,
    });

    const r1 = await startRound(caster, [victim]);
    await forceHold(admin, caster.googleSub, "Calami-Tea");
    await caster.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_chosen_player_ids: [victim.googleSub],
    });
    await closeRound(caster, r1);
    await seedRoll(r1, caster.googleSub, 5);
    await seedRoll(r1, victim.googleSub, 14);
    const out = await resolve(caster.client, r1);

    // The synth tick row exists but is negated; the roll is untouched.
    const ticks = await tickCasts(r1);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.negated).toBe(true);
    expect(out.trace.filter((s) => s.display_kind === "dice_tick")).toHaveLength(0);

    const warded = out.trace.find(
      (s) => s.display_kind === "warded" && s.target_player === victim.googleSub,
    );
    expect(warded).toBeDefined();
    expect(warded).toMatchObject({ outcome: "blocked", ward_card_name: "Cast-Iron Kettle" });
  });

  it("a genuine natural 1 still brews when another player is Calami-floored to 1", async () => {
    const nat1 = await signUp("calami-nat1-A");
    const victim = await signUp("calami-nat1-B");
    const high = await signUp("calami-nat1-C");

    const r1 = await startRound(nat1, [victim, high]);
    await forceHold(admin, nat1.googleSub, "Calami-Tea");
    const { error: castErr } = await nat1.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_chosen_player_ids: [victim.googleSub],
    });
    expect(castErr).toBeNull();

    await closeRound(nat1, r1);
    await seedRoll(r1, nat1.googleSub, 1); // genuine natural 1
    await seedRoll(r1, victim.googleSub, 2); // 2 - 1d4 -> always floored to 1
    await seedRoll(r1, high.googleSub, 15);
    const out = await resolve(nat1.client, r1);

    // victim's roll landed on the floor and is flagged reduced ...
    const vStep = diceTickStep(out, victim.googleSub);
    expect(vStep!.after).toEqual({ type: "roll", value: 1 });

    // ... so the natural-1 roller is the sole nat-1 loser and brews outright;
    // the Calami-floored victim is spared.
    expect(out.outcome).toBe("brewer");
    expect(out.brewer_id).toBe(nat1.googleSub);
  });

  it("rejects more chosen players than the card's max_targets", async () => {
    const [caster, t1, t2, t3, t4] = await Promise.all([
      signUp("calami-max-caster"),
      signUp("calami-max-t1"),
      signUp("calami-max-t2"),
      signUp("calami-max-t3"),
      signUp("calami-max-t4"),
    ]);
    await forceHold(admin, caster.googleSub, "Calami-Tea");
    const roundId = await startRound(caster, [t1, t2, t3, t4]);

    const { error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [t1.googleSub, t2.googleSub, t3.googleSub, t4.googleSub],
    });
    expect(error).not.toBeNull();
  });
});
