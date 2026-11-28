import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
  declareInAs,
  startRoundAs,
} from "./setup";

// Runs against a real local Supabase stack. Exercises Marked for Brew (issue
// #436, spec #401): "Mark a target. Within the next 5 rounds they take part
// in, the first time they roll a nat 1 or nat 20, you draw the card instead."
//
// The cast projects a Draw Redirect mark on the target; _apply_crit_redirect,
// shared by all three crit entry points, hands the target's first crit draw
// in the window to the caster and spends the mark. Assertions are on
// observable outcomes: who holds the pending draw (or the drawn card), what
// the mark's source cast records, and the Resolution Trace.

const MARK_PARAMS = { trigger: "next_crit", persist: true, participated_rounds_after_cast: 5 };

describe.skipIf(!hasAnonTestEnv)("Marked for Brew (issue #436)", () => {
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

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  async function startRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await startRoundAs(starter.client);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await declareInAs(o.client, roundId);
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  /** Moves a round into the past and marks it resolved, so a later one can start. */
  async function resolveInPast(roundId: string, startedMinutesAgo: number) {
    const { error } = await admin
      .from("rounds")
      .update({ status: "resolved", started_at: minutesAgo(startedMinutesAgo), resolved_at: minutesAgo(startedMinutesAgo) })
      .eq("id", roundId);
    expect(error).toBeNull();
  }

  /** A resolved past round; `rolled` players get a layer-0 roll, the rest of `participants` none. */
  async function seedPastRound(roomId: string, participants: string[], startedMinutesAgo: number, rolled = participants) {
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: roomId,
        started_by: participants[0],
        status: "resolved",
        started_at: minutesAgo(startedMinutesAgo),
        resolved_at: minutesAgo(startedMinutesAgo),
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const roundId = data!.id as string;
    cleanup.trackRound(roundId);
    const { error: pErr } = await admin
      .from("round_participants")
      .insert(participants.map((player_id) => ({ round_id: roundId, player_id })));
    expect(pErr).toBeNull();
    if (rolled.length > 0) {
      const { error: rErr } = await admin.from("rolls").insert(
        rolled.map((player_id, i) => ({
          round_id: roundId,
          player_id,
          layer: 0,
          value: 8 + i,
          input_mode: "manual",
          modifier_snapshot: 0,
        })),
      );
      expect(rErr).toBeNull();
    }
    return roundId;
  }

  /**
   * Caster casts Marked for Brew on target in a fresh round, which is then
   * moved 2 hours into the past and resolved. `extra` players declare in too.
   */
  async function castMark(label: string, extra: string[] = []) {
    const [caster, target, ...others] = await Promise.all(
      ["caster", "target", ...extra].map((role) => signUp(`mfb-${label}-${role}`)),
    );
    const castRound = await startRound(caster!, [target!, ...others]);
    await forceHold(admin, caster!.googleSub, "Marked for Brew");
    const { data: castId, error } = await caster!.client.rpc("cast_spell_card", {
      p_round_id: castRound,
      p_target_player_id: target!.googleSub,
    });
    expect(error).toBeNull();
    await resolveInPast(castRound, 120);
    return { caster: caster!, target: target!, others, castRound, castId: castId as string };
  }

  async function recordCrit(player: Player, roundId: string, trigger: "nat1" | "nat20" = "nat20") {
    const { error } = await player.client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: trigger });
    expect(error).toBeNull();
  }

  async function pendingDraws(roundId: string): Promise<Record<string, string>> {
    const { data, error } = await admin.from("pending_spell_draws").select("player_id, trigger").eq("round_id", roundId);
    expect(error).toBeNull();
    return Object.fromEntries((data ?? []).map((r) => [r.player_id as string, r.trigger as string]));
  }

  async function castInputs(castId: string) {
    const { data, error } = await admin.from("spell_casts").select("cast_inputs").eq("id", castId).single();
    expect(error).toBeNull();
    return (data!.cast_inputs ?? {}) as Record<string, unknown>;
  }

  // ==========================================================================
  // The mark
  // ==========================================================================

  it("the cast projects an unbounded Draw Redirect mark on the target, beneficiary = caster", async () => {
    const { caster, target, castId } = await castMark("projects");

    const { data, error } = await admin
      .from("spell_active_effects")
      .select("target_player_id, caster_id, effect_kind, effect_params, rounds_remaining")
      .eq("source_cast_id", castId);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        target_player_id: target.googleSub,
        caster_id: caster.googleSub,
        effect_kind: "draw_redirect",
        effect_params: MARK_PARAMS,
        rounds_remaining: null,
      },
    ]);
  });

  // ==========================================================================
  // Firing in the window
  // ==========================================================================

  it("hands the target's first crit draw in the window to the caster and spends the mark", async () => {
    const { caster, target, castId } = await castMark("fires");
    const roundId = await startRound(caster, [target]);

    await recordCrit(target, roundId, "nat1");

    expect(await pendingDraws(roundId)).toEqual({ [caster.googleSub]: "nat1" });
    expect(await castInputs(castId)).toMatchObject({
      consumed_by_round: roundId,
      draw_redirect_outcome: "redirected",
    });

    // "The first time": a second crit the same round, in a tie-break layer,
    // is the target's own.
    const { error: layerErr } = await admin.from("rounds").update({ current_layer: 1 }).eq("id", roundId);
    expect(layerErr).toBeNull();
    await recordCrit(target, roundId);
    expect(await pendingDraws(roundId)).toEqual({ [caster.googleSub]: "nat1", [target.googleSub]: "nat20" });
  });

  it("a retried crit call in the same layer draws once, for the caster", async () => {
    const { caster, target } = await castMark("retry");
    const roundId = await startRound(caster, [target]);

    await recordCrit(target, roundId);
    await recordCrit(target, roundId);

    expect(await pendingDraws(roundId)).toEqual({ [caster.googleSub]: "nat20" });
  });

  it("never fires in the cast round itself", async () => {
    const [caster, target] = await Promise.all([signUp("mfb-castround-caster"), signUp("mfb-castround-target")]);
    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Marked for Brew");
    const { data: castId, error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(error).toBeNull();

    await recordCrit(target, roundId);

    expect(await pendingDraws(roundId)).toEqual({ [target.googleSub]: "nat20" });
    expect(await castInputs(castId as string)).not.toHaveProperty("consumed_by_round");
  });

  it("counts only rounds the target took part in, including rounds they didn't roll in", async () => {
    const { caster, target, castId } = await castMark("window-5th");
    const room = caster.roomId;
    // Four participated rounds after the cast round -- one of them without a
    // roll -- and two the target sat out.
    await seedPastRound(room, [caster.googleSub, target.googleSub], 100);
    await seedPastRound(room, [caster.googleSub], 90);
    await seedPastRound(room, [caster.googleSub, target.googleSub], 80, [caster.googleSub]);
    await seedPastRound(room, [caster.googleSub], 70);
    await seedPastRound(room, [caster.googleSub, target.googleSub], 60);
    await seedPastRound(room, [caster.googleSub, target.googleSub], 50);

    // The live round is the target's 5th round of taking part: still in the window.
    const roundId = await startRound(caster, [target]);
    await recordCrit(target, roundId);

    expect(await pendingDraws(roundId)).toEqual({ [caster.googleSub]: "nat20" });
    expect(await castInputs(castId)).toMatchObject({ consumed_by_round: roundId });
  });

  it("the roster badge counts down the target's participated rounds after the cast (issue #464)", async () => {
    const { caster, target, castId } = await castMark("badge");
    const room = caster.roomId;
    const { data: mark } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("source_cast_id", castId)
      .single();
    const markBadge = async () => {
      const { data, error } = await target.client.rpc("get_room_active_effects", { p_room_id: room });
      expect(error).toBeNull();
      return (data as { effect_id: string; rounds_remaining: number | null }[])
        .filter((b) => b.effect_id === mark!.id)
        .map((b) => b.rounds_remaining);
    };

    // The cast round does not count: the full window is left.
    expect(await markBadge()).toEqual([5]);

    // Two rounds the target took part in, one they sat out.
    await seedPastRound(room, [caster.googleSub, target.googleSub], 100);
    await seedPastRound(room, [caster.googleSub], 90);
    await seedPastRound(room, [caster.googleSub, target.googleSub], 80);
    await startRound(caster, [target]);

    expect(await markBadge()).toEqual([3]);
  });

  it("expires silently after the target's 5th round of taking part", async () => {
    const { caster, target, castId } = await castMark("window-6th");
    const room = caster.roomId;
    for (const m of [100, 90, 80, 70, 60]) {
      await seedPastRound(room, [caster.googleSub, target.googleSub], m);
    }

    // The 6th: outside the window, the target draws their own card.
    const roundId = await startRound(caster, [target]);
    await recordCrit(target, roundId);

    expect(await pendingDraws(roundId)).toEqual({ [target.googleSub]: "nat20" });
    expect(await castInputs(castId)).not.toHaveProperty("consumed_by_round");
  });

  it("fires the oldest live mark first; a later mark waits for the next crit", async () => {
    const { caster: first, target, castId: firstCastId, others } = await castMark("fifo", ["second"]);
    const second = others[0]!;
    // A second mark, cast by `second` a round later.
    const secondRound = await startRound(second, [target, first]);
    await forceHold(admin, second.googleSub, "Marked for Brew");
    const { data: secondCastId, error } = await second.client.rpc("cast_spell_card", {
      p_round_id: secondRound,
      p_target_player_id: target.googleSub,
    });
    expect(error).toBeNull();
    await resolveInPast(secondRound, 100);

    const roundId = await startRound(first, [target, second]);
    await recordCrit(target, roundId);

    expect(await pendingDraws(roundId)).toEqual({ [first.googleSub]: "nat20" });
    expect(await castInputs(firstCastId)).toMatchObject({ consumed_by_round: roundId });
    expect(await castInputs(secondCastId as string)).not.toHaveProperty("consumed_by_round");
  });

  // ==========================================================================
  // Fizzle, counter
  // ==========================================================================

  it("fizzles when the caster already has a pending draw that round: the mark is spent, the target keeps their draw", async () => {
    const { caster, target, castId } = await castMark("fizzle");
    const roundId = await startRound(caster, [target]);

    await recordCrit(caster, roundId, "nat1");
    await recordCrit(target, roundId, "nat20");

    expect(await pendingDraws(roundId)).toEqual({ [caster.googleSub]: "nat1", [target.googleSub]: "nat20" });
    expect(await castInputs(castId)).toMatchObject({
      consumed_by_round: roundId,
      draw_redirect_outcome: "fizzled",
    });
  });

  it("a countered cast leaves no mark", async () => {
    const { caster, target, castId } = await castMark("countered");
    // Phase 1 of the cast round's resolve records the counter as `negated`.
    const { error } = await admin.from("spell_casts").update({ negated: true }).eq("id", castId);
    expect(error).toBeNull();

    const roundId = await startRound(caster, [target]);
    await recordCrit(target, roundId);

    expect(await pendingDraws(roundId)).toEqual({ [target.googleSub]: "nat20" });
    expect(await castInputs(castId)).not.toHaveProperty("consumed_by_round");
  });

  // ==========================================================================
  // The other two crit entry points
  // ==========================================================================

  it("draw_spell_card_as (Test-room puppet): the crit's card lands in the caster's hand", async () => {
    const [puppeteer, target] = await Promise.all([signUp("mfb-puppet-admin"), signUp("mfb-puppet-target")]);
    const { error: adminErr } = await admin.from("players").update({ is_admin: true }).eq("id", puppeteer.googleSub);
    expect(adminErr).toBeNull();
    const roomId = await seedDedicatedRoom(admin, cleanup, [puppeteer.googleSub, target.googleSub], { isTest: true });
    const castRound = await seedPastRound(roomId, [puppeteer.googleSub, target.googleSub], 60);
    const { castId } = await seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId: target.googleSub,
      casterId: puppeteer.googleSub,
      cardName: "Marked for Brew",
      effectKind: "draw_redirect",
      effectParams: MARK_PARAMS,
      roundId: castRound,
    });
    const critRound = await seedPastRound(roomId, [puppeteer.googleSub, target.googleSub], 30);

    const { data, error } = await puppeteer.client.rpc("draw_spell_card_as", {
      p_trigger: "nat20",
      p_room_id: roomId,
      p_round_id: critRound,
      p_player_id: target.googleSub,
    });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string }[];
    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", row!.instance_id)
      .single();
    expect(instance).toEqual({ location: "held", held_by_player: puppeteer.googleSub });
    expect(await castInputs(castId)).toMatchObject({ consumed_by_round: critRound });
  });

  // ==========================================================================
  // Replay, trace
  // ==========================================================================
});
