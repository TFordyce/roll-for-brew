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

// Runs against a real Supabase stack. Exercises migration
// 0097_persistent_advantage.sql (issue #320, Tier A primitive 4 of the
// effect-application rebuild #302 / ADR 0005): Prophe-Tea's "roll every round
// with advantage for the rest of the day" as an unbounded advantage
// spell_active_effects projection row, applied by the eager shim (submit_roll)
// and traced by resolve_round Phase 3. Asserts externally observable outcomes
// only (spec: Testing Decisions).

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
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("persistent advantage — Prophe-Tea (issue #320)", () => {
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

  async function openAndCloseRound(
    starter: Awaited<ReturnType<typeof signUp>>,
    others: Awaited<ReturnType<typeof signUp>>[],
  ) {
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

  async function rollRow(roundId: string, playerId: string) {
    const { data, error } = await admin
      .from("rolls")
      .select("value, discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", playerId)
      .eq("layer", 0)
      .single();
    expect(error).toBeNull();
    return data as { value: number; discarded_value: number | null };
  }

  async function seedRollWithDiscard(
    roundId: string,
    playerId: string,
    value: number,
    discardedValue: number | null,
  ) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: 0,
      discarded_value: discardedValue,
    });
    expect(error).toBeNull();
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  // -----------------------------------------------------------------------
  // End-to-end: the real cast RPC + the real eager shim, across rounds.
  // -----------------------------------------------------------------------

  it("is un-benched and casting it promotes an unbounded advantage active effect", async () => {
    const caster = await signUp("prophe-cast");
    const other = await signUp("prophe-cast-other");

    // Un-benched: a live in_deck instance exists.
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "Prophe-Tea")
      .single();
    expect(inst!.location).toBe("in_deck");

    const instanceId = await forceHold(admin, caster.googleSub, "Prophe-Tea");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
    });
    expect(castErr).toBeNull();
    expect(castId).toBeTruthy();

    // The held instance is consumed.
    const { data: after } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", instanceId)
      .single();
    expect(after!.location).toBe("in_deck");
    expect(after!.held_by_player).toBeNull();

    // A CASTER-targeted advantage cast row exists this round...
    const { data: casts } = await admin
      .from("spell_casts")
      .select("effect_kind, target_player_id")
      .eq("round_id", roundId);
    expect(casts).toContainEqual({ effect_kind: "advantage", target_player_id: caster.googleSub });

    // ...and it promoted an UNBOUNDED (rounds_remaining null) advantage
    // projection row on the caster.
    const { data: effects } = await admin
      .from("spell_active_effects")
      .select("effect_kind, target_player_id, rounds_remaining, effect_params")
      .eq("caster_id", caster.googleSub)
      .eq("effect_kind", "advantage");
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      effect_kind: "advantage",
      target_player_id: caster.googleSub,
      rounds_remaining: null,
    });
  });

  it("carries advantage across three consecutive rounds via the projection", async () => {
    const caster = await signUp("prophe-3r");
    const other = await signUp("prophe-3r-other");
    await forceHold(admin, caster.googleSub, "Prophe-Tea");

    // Round 1 — cast Prophe-Tea while open, then close + roll.
    const { data: r1 } = await caster.client.rpc("start_round");
    cleanup.trackRound(r1 as string);
    await other.client.rpc("declare_in", { p_round_id: r1 });
    const { error: castErr } = await caster.client.rpc("cast_spell_card", { p_round_id: r1 });
    expect(castErr).toBeNull();
    await caster.client.rpc("close_round", { p_round_id: r1 });
    await caster.client.rpc("submit_roll", { p_round_id: r1 });
    await other.client.rpc("submit_roll", { p_round_id: r1 });
    await resolve(caster.client, r1);
    await admin.from("rounds").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", r1);

    const roll1 = await rollRow(r1, caster.googleSub);
    expect(roll1.discarded_value).not.toBeNull();
    expect(roll1.value).toBeGreaterThanOrEqual(roll1.discarded_value as number);
    // control: the other player has no advantage
    expect((await rollRow(r1, other.googleSub)).discarded_value).toBeNull();

    // Rounds 2 and 3 — no cast at all; advantage must persist off the projection.
    for (const label of ["r2", "r3"]) {
      const { data: rid } = await caster.client.rpc("start_round");
      cleanup.trackRound(rid as string);
      await other.client.rpc("declare_in", { p_round_id: rid });
      await caster.client.rpc("close_round", { p_round_id: rid });
      await caster.client.rpc("submit_roll", { p_round_id: rid });
      await other.client.rpc("submit_roll", { p_round_id: rid });
      await resolve(caster.client, rid);
      await admin
        .from("rounds")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("id", rid);

      const cRoll = await rollRow(rid as string, caster.googleSub);
      expect(cRoll.discarded_value, `advantage lost in ${label}`).not.toBeNull();
      expect(cRoll.value).toBeGreaterThanOrEqual(cRoll.discarded_value as number);
      expect((await rollRow(rid as string, other.googleSub)).discarded_value).toBeNull();
    }
  });

  // -----------------------------------------------------------------------
  // resolve_round Phase 3 Trace step (seeded projection row).
  // -----------------------------------------------------------------------

  it("resolve_round emits an advantage Trace step sourced from the projection row", async () => {
    const caster = await signUp("prophe-trace");
    const other = await signUp("prophe-trace-other");

    const { effectId } = await seedActiveEffect(admin, cleanup, {
      roomId: caster.roomId,
      targetPlayerId: caster.googleSub,
      casterId: caster.googleSub,
      cardName: "Prophe-Tea",
      effectKind: "advantage",
      effectParams: { persist: true },
      roundsRemaining: null,
    });

    const roundId = await openAndCloseRound(caster, [other]);
    // kept die 17, other die 9 -> advantage: before = 9, after = 17.
    await seedRollWithDiscard(roundId, caster.googleSub, 17, 9);
    await seedRollWithDiscard(roundId, other.googleSub, 12, null);

    const out = await resolve(caster.client, roundId);

    const advSteps = out.trace.filter((s) => s.display_kind === "advantage");
    expect(advSteps).toHaveLength(1);
    expect(advSteps[0]).toMatchObject({
      display_kind: "advantage",
      target_player: caster.googleSub,
      before: { type: "roll", value: 9 },
      after: { type: "roll", value: 17 },
    });
    expect(advSteps[0]!.source_cast.active_effect_id).toBe(effectId);
    expect(advSteps[0]!.source_cast.cast_id).toBeNull();
    expect(advSteps[0]!.source_cast.card_name).toBe("Prophe-Tea");
    expect(advSteps[0]!.source_cast.caster_player_id).toBe(caster.googleSub);

    // Idempotent: a second resolve produces the same single advantage step.
    const out2 = await resolve(caster.client, roundId);
    expect(out2.trace.filter((s) => s.display_kind === "advantage")).toHaveLength(1);
  });

  it("negating the originating cast re-projects the advantage away", async () => {
    const caster = await signUp("prophe-negate");
    const other = await signUp("prophe-negate-other");

    const { effectId, castId } = await seedActiveEffect(admin, cleanup, {
      roomId: caster.roomId,
      targetPlayerId: caster.googleSub,
      casterId: caster.googleSub,
      cardName: "Prophe-Tea",
      effectKind: "advantage",
      effectParams: { persist: true },
      roundsRemaining: null,
    });

    // Negate the source cast (what a successful counter would leave behind).
    await admin.from("spell_casts").update({ negated: true }).eq("id", castId);

    const roundId = await openAndCloseRound(caster, [other]);
    await seedRollWithDiscard(roundId, caster.googleSub, 17, 9);
    await seedRollWithDiscard(roundId, other.googleSub, 12, null);

    const out = await resolve(caster.client, roundId);
    expect(out.trace.filter((s) => s.display_kind === "advantage")).toHaveLength(0);

    // And it is no longer a live active effect on the roster.
    const { data: roster } = await caster.client.rpc("get_room_active_effects", {
      p_room_id: caster.roomId,
    });
    expect((roster as { effect_id: string }[]).some((r) => r.effect_id === effectId)).toBe(false);
  });

  it("a dispel cast ends the persistent advantage from that round onward", async () => {
    const caster = await signUp("prophe-dispel");
    const other = await signUp("prophe-dispel-other");

    const { effectId } = await seedActiveEffect(admin, cleanup, {
      roomId: caster.roomId,
      targetPlayerId: caster.googleSub,
      casterId: caster.googleSub,
      cardName: "Prophe-Tea",
      effectKind: "advantage",
      effectParams: { persist: true },
      roundsRemaining: null,
    });

    // A logged dispel cast naming the effect, in its own resolved round
    // (spec §5: dispel is a logged cast the projection honours, not a DELETE).
    const { data: dispelRound } = await admin
      .from("rounds")
      .insert({
        room_id: caster.roomId,
        started_by: caster.googleSub,
        status: "resolved",
        resolved_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    cleanup.trackRound(dispelRound!.id as string);
    const dispelInstance = await forceHold(admin, other.googleSub, "Lesser Detox");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", dispelInstance);
    await admin.from("spell_casts").insert({
      round_id: dispelRound!.id,
      caster_id: other.googleSub,
      card_instance_id: dispelInstance,
      target_player_id: caster.googleSub,
      target_pending: false,
      effect_kind: "dispel",
      effect_params: { ended_effect_id: effectId },
    });

    const roundId = await openAndCloseRound(caster, [other]);
    await seedRollWithDiscard(roundId, caster.googleSub, 17, 9);
    await seedRollWithDiscard(roundId, other.googleSub, 12, null);

    const out = await resolve(caster.client, roundId);
    expect(out.trace.filter((s) => s.display_kind === "advantage")).toHaveLength(0);
  });

  it("a modifier-domain ward on the caster does not touch the roll-domain advantage", async () => {
    const caster = await signUp("prophe-ward");
    const other = await signUp("prophe-ward-other");

    const { effectId } = await seedActiveEffect(admin, cleanup, {
      roomId: caster.roomId,
      targetPlayerId: caster.googleSub,
      casterId: caster.googleSub,
      cardName: "Prophe-Tea",
      effectKind: "advantage",
      effectParams: { persist: true },
      roundsRemaining: null,
    });
    // Bag for Life: modifier-domain, both polarities. Advantage is roll-domain,
    // so this must not block it (roll-domain ward interaction is #335).
    await seedActiveEffect(admin, cleanup, {
      roomId: caster.roomId,
      targetPlayerId: caster.googleSub,
      casterId: caster.googleSub,
      cardName: "Bag for Life",
      effectKind: "ward",
      effectParams: { polarity: ["positive", "negative"], domain: ["modifier"], block_copy: true },
      roundsRemaining: null,
    });

    const roundId = await openAndCloseRound(caster, [other]);
    await seedRollWithDiscard(roundId, caster.googleSub, 17, 9);
    await seedRollWithDiscard(roundId, other.googleSub, 12, null);

    const out = await resolve(caster.client, roundId);
    const advSteps = out.trace.filter((s) => s.display_kind === "advantage");
    expect(advSteps).toHaveLength(1);
    expect(advSteps[0]!.source_cast.active_effect_id).toBe(effectId);
    expect(out.trace.some((s) => s.display_kind === "warded")).toBe(false);
  });
});
