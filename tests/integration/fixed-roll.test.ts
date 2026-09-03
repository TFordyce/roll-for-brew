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

// Runs against a real Supabase stack. Exercises Tier A primitive 1 —
// Fixed-roll (issue #317, spec #302 §12 / ADR 0005, migration 0094):
//
//   * Steady Hand (SELF, common)        — the caster's d20 is treated as a 10.
//   * Sleeping Camomile (OPPONENT, rare) — the target's result counts as a 1.
//
// submit_roll records the before->after into cast_inputs.roll_transform
// (kind 'fixed_roll', order 0) exactly like the other eager-shim roll kinds,
// and resolve_round(uuid) Phase 3 adopts it with no recomputation, emitting
// one before->after Trace step. A matching earlier roll-domain ward pre-empts
// the override (no mutation, a `warded` marker + `blocked` Trace step).
//
// Assertions are on externally observable outcomes only — rolls.value, the
// recorded roll_transform, the Trace, and the brewer (spec: Testing
// Decisions).

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
  outcome: string;
  blocked_cast_id?: string | null;
  ward_cast_id?: string | null;
  ward_card_name?: string | null;
  would_be_before?: number | string | null;
  would_be_after?: number | string | null;
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

type RollTransformPlayer = {
  player_id: string;
  before: number;
  after: number;
  warded?: boolean;
  would_be_after?: number;
  ward_cast_id?: string;
  ward_card_name?: string;
};

type RollTransform = { kind: string; order: number; players: RollTransformPlayer[] };

describe.skipIf(!hasAnonTestEnv)("fixed-roll primitive (#317): Steady Hand, Sleeping Camomile", () => {
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

  /** start_round + every `others` player declares in. Round left `open`. */
  async function startRound(
    starter: Awaited<ReturnType<typeof signUp>>,
    others: Awaited<ReturnType<typeof signUp>>[],
  ): Promise<string> {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function closeRound(starter: Awaited<ReturnType<typeof signUp>>, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
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

  async function seedCast(
    roundId: string,
    casterId: string,
    donorCard: string,
    row: {
      effectKind: string;
      effectParams: Record<string, unknown>;
      targetPlayerId: string | null;
      castInputs?: Record<string, unknown>;
      negated?: boolean;
    },
  ): Promise<string> {
    const instanceId = await forceHold(admin, casterId, donorCard);
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
        cast_inputs: row.castInputs ?? null,
        negated: row.negated ?? false,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  async function readRollTransform(roundId: string): Promise<RollTransform> {
    const { data, error } = await admin
      .from("spell_casts")
      .select("cast_inputs")
      .eq("round_id", roundId)
      .eq("effect_kind", "fixed_roll")
      .single();
    expect(error).toBeNull();
    return (data!.cast_inputs as { roll_transform: RollTransform }).roll_transform;
  }

  async function readRoll(roundId: string, playerId: string): Promise<number> {
    const { data, error } = await admin
      .from("rolls")
      .select("value")
      .eq("round_id", roundId)
      .eq("player_id", playerId)
      .single();
    expect(error).toBeNull();
    return data!.value as number;
  }

  // --------------------------------------------------------------------
  // Steady Hand — self, fixed d20 = 10
  // --------------------------------------------------------------------

  it("Steady Hand forces the caster's d20 to 10, records before->after, and resolve_round adopts it", async () => {
    const caster = await signUp("fr-steady-caster");
    const opponent = await signUp("fr-steady-opp");
    await forceHold(admin, caster.googleSub, "Steady Hand");

    const roundId = await startRound(caster, [opponent]);
    const { error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castErr).toBeNull();
    await closeRound(caster, roundId);

    // Opponent's roll seeded deterministically; the caster rolls for real so
    // the whole submit_roll override path runs.
    await seedRoll(roundId, opponent.googleSub, 15);
    const { error: rollErr } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr).toBeNull();

    // rolls.value was overridden to the constant.
    expect(await readRoll(roundId, caster.googleSub)).toBe(10);

    const rt = await readRollTransform(roundId);
    expect(rt.kind).toBe("fixed_roll");
    expect(rt.order).toBe(0);
    expect(rt.players).toHaveLength(1);
    expect(rt.players[0]!.player_id).toBe(caster.googleSub);
    expect(rt.players[0]!.after).toBe(10);
    expect(rt.players[0]!.before).toBeGreaterThanOrEqual(1);
    expect(rt.players[0]!.before).toBeLessThanOrEqual(20);
    expect(rt.players[0]!.warded).toBeUndefined();

    const out = await resolve(caster.client, roundId);

    const step = out.trace.find(
      (s) => s.display_kind === "fixed_roll" && s.target_player === caster.googleSub,
    );
    expect(step).toBeDefined();
    expect(step!.before).toEqual({ type: "roll", value: rt.players[0]!.before });
    expect(step!.after).toEqual({ type: "roll", value: 10 });
    expect(step!.source_cast.card_name).toBe("Steady Hand");

    // Default brewer pick: lowest roll + modifier. Caster 10 < opponent 15.
    expect(out.outcome).toBe("brewer");
    expect(out.brewer_id).toBe(caster.googleSub);
  });

  // --------------------------------------------------------------------
  // Sleeping Camomile — opponent, forced natural 1
  // --------------------------------------------------------------------

  it("Sleeping Camomile forces the target's d20 to 1, records it, and resolve_round adopts it", async () => {
    const caster = await signUp("fr-camomile-caster");
    const target = await signUp("fr-camomile-target");
    await forceHold(admin, caster.googleSub, "Sleeping Camomile");

    const roundId = await startRound(caster, [target]);
    const { error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castErr).toBeNull();
    await closeRound(caster, roundId);

    await seedRoll(roundId, caster.googleSub, 12);
    const { error: rollErr } = await target.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr).toBeNull();

    expect(await readRoll(roundId, target.googleSub)).toBe(1);

    const rt = await readRollTransform(roundId);
    expect(rt.kind).toBe("fixed_roll");
    expect(rt.order).toBe(0);
    expect(rt.players[0]!.player_id).toBe(target.googleSub);
    expect(rt.players[0]!.after).toBe(1);
    expect(rt.players[0]!.warded).toBeUndefined();

    const out = await resolve(caster.client, roundId);

    const step = out.trace.find(
      (s) => s.display_kind === "fixed_roll" && s.target_player === target.googleSub,
    );
    expect(step).toBeDefined();
    expect(step!.after).toEqual({ type: "roll", value: 1 });
    expect(step!.source_cast.card_name).toBe("Sleeping Camomile");

    // Target's forced 1 is the lowest roll — they brew by default.
    expect(out.brewer_id).toBe(target.googleSub);
  });

  // --------------------------------------------------------------------
  // Roll-domain ward pre-check (submit_roll)
  // --------------------------------------------------------------------

  it("a negative roll-domain ward on the target pre-empts Sleeping Camomile: the roll is not overridden and a warded marker is recorded", async () => {
    const caster = await signUp("fr-ward-caster");
    const target = await signUp("fr-ward-target");
    await forceHold(admin, caster.googleSub, "Sleeping Camomile");

    // A roll-domain ward carried forward from an earlier round (source cast in
    // its own resolved round, per #310). Both polarities so the outcome does
    // not hinge on the random d20 the target rolls — forcing a 1 is negative
    // for any roll >= 2 and neutral (never warded) only on an exact natural 1.
    await seedActiveEffect(admin, cleanup, {
      roomId: target.roomId,
      targetPlayerId: target.googleSub,
      casterId: target.googleSub,
      cardName: "Cast-Iron Kettle",
      effectKind: "ward",
      effectParams: { polarity: ["positive", "negative"], domain: ["roll"] },
    });

    const roundId = await startRound(caster, [target]);
    await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    await closeRound(caster, roundId);

    await seedRoll(roundId, caster.googleSub, 12);
    const { error: rollErr } = await target.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr).toBeNull();

    const actualRoll = await readRoll(roundId, target.googleSub);
    const rt = await readRollTransform(roundId);
    const p = rt.players[0]!;
    expect(p.player_id).toBe(target.googleSub);
    expect(rt.kind).toBe("fixed_roll");

    if (p.before === 1) {
      // Rare: the target genuinely rolled a natural 1, so the fixed value
      // equals the roll — neutral polarity, never warded, a no-op override.
      expect(p.warded).toBeUndefined();
      expect(p.after).toBe(1);
      expect(actualRoll).toBe(1);
    } else {
      // Forcing a 1 onto a higher roll is negative — the ward blocks it.
      expect(p.warded).toBe(true);
      expect(p.after).toBe(p.before);
      expect(actualRoll).toBe(p.before); // rolls.value untouched
      expect(p.would_be_after).toBe(1);
      expect(p.ward_card_name).toBe("Cast-Iron Kettle");

      const out = await resolve(caster.client, roundId);
      const warded = out.trace.find(
        (s) => s.display_kind === "warded" && s.target_player === target.googleSub,
      );
      expect(warded).toBeDefined();
      expect(warded!.outcome).toBe("blocked");
      expect(warded!.would_be_after).toBe(1);
      expect(warded!.ward_card_name).toBe("Cast-Iron Kettle");
    }
  });

  // --------------------------------------------------------------------
  // resolve_round Phase 3 adopts a pre-recorded warded fixed_roll marker
  // --------------------------------------------------------------------

  it("resolve_round Phase 3 turns a recorded warded fixed_roll marker into one blocked step and keeps the real roll", async () => {
    const caster = await signUp("fr-p3-caster");
    const target = await signUp("fr-p3-target");
    const roundId = await startRound(caster, [target]);
    await closeRound(caster, roundId);

    await seedRoll(roundId, caster.googleSub, 4);
    await seedRoll(roundId, target.googleSub, 17);

    const wardCastId = "00000000-0000-0000-0000-0000000000ab";
    const fixedCastId = await seedCast(roundId, caster.googleSub, "Sleeping Camomile", {
      effectKind: "fixed_roll",
      effectParams: { value: 1 },
      targetPlayerId: target.googleSub,
      castInputs: {
        roll_transform: {
          kind: "fixed_roll",
          order: 0,
          players: [
            {
              player_id: target.googleSub,
              before: 17,
              after: 17,
              warded: true,
              would_be_after: 1,
              ward_cast_id: wardCastId,
              ward_card_name: "Cast-Iron Kettle",
            },
          ],
        },
      },
    });

    const out = await resolve(caster.client, roundId);

    const warded = out.trace.find(
      (s) => s.display_kind === "warded" && s.target_player === target.googleSub,
    );
    expect(warded).toBeDefined();
    expect(warded!.outcome).toBe("blocked");
    expect(warded!.blocked_cast_id).toBe(fixedCastId);
    expect(warded!.would_be_after).toBe(1);
    expect(warded!.ward_card_name).toBe("Cast-Iron Kettle");

    // The forced 1 was blocked — the target keeps their real 17, so the
    // caster (4) is the lowest and brews.
    expect(out.brewer_id).toBe(caster.googleSub);
    expect(out.trace.some((s) => s.display_kind === "fixed_roll")).toBe(false);
  });

  // --------------------------------------------------------------------
  // Countered fixed_roll — Phase 3 logical unwind (spec #302 §8)
  // --------------------------------------------------------------------

  it("a negated (countered) fixed_roll is logically unwound: Phase 3 adopts the recorded `before` and emits no step", async () => {
    const caster = await signUp("fr-neg-caster");
    const target = await signUp("fr-neg-target");
    const roundId = await startRound(caster, [target]);
    await closeRound(caster, roundId);

    await seedRoll(roundId, caster.googleSub, 8);
    await seedRoll(roundId, target.googleSub, 17);

    // A fixed_roll cast that recorded a normal 17 -> 1 transform, then got
    // countered: resolve_round Phase 1 short-circuits with no counters, so the
    // hand-set `negated` stands and Phase 3 takes its is_negated branch.
    await seedCast(roundId, caster.googleSub, "Sleeping Camomile", {
      effectKind: "fixed_roll",
      effectParams: { value: 1 },
      targetPlayerId: target.googleSub,
      negated: true,
      castInputs: {
        roll_transform: {
          kind: "fixed_roll",
          order: 0,
          players: [{ player_id: target.googleSub, before: 17, after: 1 }],
        },
      },
    });

    const out = await resolve(caster.client, roundId);

    // No fixed_roll step for a negated transform; target keeps their real 17,
    // so the caster (8) is lowest and brews.
    expect(out.trace.some((s) => s.display_kind === "fixed_roll")).toBe(false);
    expect(out.brewer_id).toBe(caster.googleSub);
  });

  // --------------------------------------------------------------------
  // Idempotence (ADR 0005 invariant)
  // --------------------------------------------------------------------

  it("resolve_round over a fixed_roll is idempotent — a second run yields the same brewer and Trace", async () => {
    const caster = await signUp("fr-idem-caster");
    const target = await signUp("fr-idem-target");
    const roundId = await startRound(caster, [target]);
    await closeRound(caster, roundId);

    await seedRoll(roundId, caster.googleSub, 15);
    await seedRoll(roundId, target.googleSub, 12);
    await seedCast(roundId, caster.googleSub, "Steady Hand", {
      effectKind: "fixed_roll",
      effectParams: { value: 10 },
      targetPlayerId: caster.googleSub,
      castInputs: {
        roll_transform: {
          kind: "fixed_roll",
          order: 0,
          players: [{ player_id: caster.googleSub, before: 15, after: 10 }],
        },
      },
    });

    const first = await resolve(caster.client, roundId);
    const second = await resolve(caster.client, roundId);

    expect(second.brewer_id).toBe(first.brewer_id);
    expect(second.brewer_id).toBe(caster.googleSub); // fixed 10 < target 12
    expect(second.trace).toEqual(first.trace);
  });

  // --------------------------------------------------------------------
  // Chaining — a later roll_flip composes onto the fixed value (order 0 -> 3)
  // --------------------------------------------------------------------

  it("a later roll_flip chains off the fixed value: Phase 3 walks fixed_roll then roll_flip", async () => {
    const caster = await signUp("fr-chain-caster");
    const target = await signUp("fr-chain-target");
    const roundId = await startRound(caster, [target]);
    await closeRound(caster, roundId);

    await seedRoll(roundId, caster.googleSub, 6);
    await seedRoll(roundId, target.googleSub, 5);

    // fixed_roll sets the target to 10 (order 0); a later roll_flip records
    // 10 -> 11 (order 3), its `before` chained from the fixed value.
    await seedCast(roundId, caster.googleSub, "Sleeping Camomile", {
      effectKind: "fixed_roll",
      effectParams: { value: 10 },
      targetPlayerId: target.googleSub,
      castInputs: {
        roll_transform: {
          kind: "fixed_roll",
          order: 0,
          players: [{ player_id: target.googleSub, before: 5, after: 10 }],
        },
      },
    });
    await seedCast(roundId, caster.googleSub, "Fortune's Flavour", {
      effectKind: "roll_flip",
      effectParams: {},
      targetPlayerId: null,
      castInputs: {
        roll_transform: {
          kind: "roll_flip",
          order: 3,
          players: [{ player_id: target.googleSub, before: 10, after: 11 }],
        },
      },
    });

    const out = await resolve(caster.client, roundId);

    const targetRollSteps = out.trace.filter(
      (s) => s.target_player === target.googleSub && s.before.type === "roll",
    );
    expect(targetRollSteps.map((s) => s.display_kind)).toEqual(["fixed_roll", "roll_flip"]);
    expect(targetRollSteps[0]!.after).toEqual({ type: "roll", value: 10 });
    expect(targetRollSteps[1]!.before).toEqual({ type: "roll", value: 10 });
    expect(targetRollSteps[1]!.after).toEqual({ type: "roll", value: 11 });

    // Final adopted roll is 11; the caster (6) is lowest and brews.
    expect(out.brewer_id).toBe(caster.googleSub);
  });
});
