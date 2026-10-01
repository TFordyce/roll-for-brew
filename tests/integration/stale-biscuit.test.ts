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
} from "./setup";

// Runs against a real local Supabase stack. Exercises Stale Biscuit (issue
// #437, spec #401): "Mark a target. The very next card they would draw goes
// to you instead."
//
// The cast projects a `next_draw` Draw Redirect mark on the target;
// _land_drawn_instance, shared by all four draw RPCs, lands the target's next
// drawn card with the caster (the beneficiary) and spends the mark.
// Assertions are on observable outcomes: where the drawn instance sits, who
// the spell_draws row names, what the mark's source cast records, and the
// Resolution Trace.

type TraceStep = {
  display_kind: string;
  target_player: string | null;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  redirect_trigger?: string;
};

type DrawResult = { instance_id: string; needs_swap_decision: boolean };

const MARK_PARAMS = { trigger: "next_draw", persist: true };

describe.skipIf(!hasAnonTestEnv)("Stale Biscuit (issue #437)", () => {
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
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
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

  async function castBiscuit(caster: Player, target: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, "Stale Biscuit");
    const { data: castId, error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(error).toBeNull();
    return castId as string;
  }

  /**
   * Caster casts Stale Biscuit on target in a fresh round, which is then moved
   * 2 hours into the past and resolved. `extra` players declare in too.
   */
  async function castMark(label: string, extra: string[] = []) {
    const [caster, target, ...others] = await Promise.all(
      ["caster", "target", ...extra].map((role) => signUp(`sb-${label}-${role}`)),
    );
    const castRound = await startRound(caster!, [target!, ...others]);
    const castId = await castBiscuit(caster!, target!, castRound);
    await resolveInPast(castRound, 120);
    return { caster: caster!, target: target!, others, castRound, castId };
  }

  async function recordCrit(player: Player, roundId: string, trigger: "nat1" | "nat20" = "nat20") {
    const { error } = await player.client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: trigger });
    expect(error).toBeNull();
  }

  /** The player crits in roundId and draws the pending card in-app (a random card). */
  async function critAndDraw(player: Player, roundId: string, trigger: "nat1" | "nat20" = "nat20") {
    await recordCrit(player, roundId, trigger);
    const { data, error } = await player.client.rpc("draw_pending_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    const [row] = data as DrawResult[];
    expect(row).toBeDefined();
    return row!;
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

  async function hand(playerId: string) {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("id, location")
      .eq("held_by_player", playerId)
      .order("location");
    expect(error).toBeNull();
    return (data ?? []) as { id: string; location: string }[];
  }

  async function castInputs(castId: string) {
    const { data, error } = await admin.from("spell_casts").select("cast_inputs").eq("id", castId).single();
    expect(error).toBeNull();
    return (data!.cast_inputs ?? {}) as Record<string, unknown>;
  }

  async function drawLog(instanceId: string) {
    const { data, error } = await admin
      .from("spell_draws")
      .select("id, player_id, trigger")
      .eq("card_instance_id", instanceId);
    expect(error).toBeNull();
    return (data ?? []) as { id: string; player_id: string; trigger: string }[];
  }

  async function traceSteps(roundId: string): Promise<TraceStep[]> {
    const { data, error } = await admin.from("rounds").select("resolution_trace").eq("id", roundId).single();
    expect(error).toBeNull();
    return ((data!.resolution_trace ?? []) as TraceStep[]).filter((s) => s.display_kind === "draw_redirect");
  }

  /** Any card currently in the deck, for a manual draw. */
  async function someInDeckCardId() {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("card_id")
      .eq("location", "in_deck")
      .limit(1)
      .single();
    expect(error).toBeNull();
    return data!.card_id as string;
  }

  // ==========================================================================
  // The mark
  // ==========================================================================

  it("the cast projects an unbounded next_draw mark on the target, beneficiary = caster", async () => {
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
  // Firing on a draw
  // ==========================================================================

  it("in-app draw: the target's drawn card lands in the caster's hand and the mark is spent", async () => {
    const { caster, target, castId } = await castMark("inapp");
    const roundId = await startRound(caster, [target]);

    const drawn = await critAndDraw(target, roundId);

    expect(drawn.needs_swap_decision).toBe(false);
    expect(await instance(drawn.instance_id)).toEqual({ location: "held", held_by_player: caster.googleSub });
    expect(await hand(target.googleSub)).toEqual([]);
    const log = await drawLog(drawn.instance_id);
    expect(log).toEqual([{ id: expect.any(String), player_id: caster.googleSub, trigger: "nat20" }]);
    expect(await castInputs(castId)).toMatchObject({
      consumed_by_draw: log[0]!.id,
      draw_redirect_outcome: "redirected",
    });

    // "The very next card": the target's following draw is their own.
    await resolveInPast(roundId, 60);
    const roundId2 = await startRound(caster, [target]);
    const second = await critAndDraw(target, roundId2);
    expect(await instance(second.instance_id)).toEqual({ location: "held", held_by_player: target.googleSub });
  });

  it("manual draw: the card the target names goes to the caster", async () => {
    const { caster, target, castId } = await castMark("manual");
    const roundId = await startRound(caster, [target]);
    await recordCrit(target, roundId);
    const cardId = await someInDeckCardId();

    const { data, error } = await target.client.rpc("draw_pending_spell_card_manual", {
      p_round_id: roundId,
      p_card_id: cardId,
    });
    expect(error).toBeNull();
    const [row] = data as DrawResult[];

    expect(row!.needs_swap_decision).toBe(false);
    expect(await instance(row!.instance_id)).toEqual({ location: "held", held_by_player: caster.googleSub });
    expect(await castInputs(castId)).toMatchObject({ draw_redirect_outcome: "redirected" });
  });

  it("a caster already holding a card gets the redirected card as a keep-or-swap choice", async () => {
    const { caster, target } = await castMark("fullhand");
    const keptId = await forceHold(admin, caster.googleSub, "Steady Hand");
    const roundId = await startRound(caster, [target]);

    const drawn = await critAndDraw(target, roundId);

    // The target has no decision to make; the caster does.
    expect(drawn.needs_swap_decision).toBe(false);
    expect(await instance(drawn.instance_id)).toEqual({ location: "pending_swap", held_by_player: caster.googleSub });
    expect(await instance(keptId)).toEqual({ location: "held", held_by_player: caster.googleSub });
  });

  it("a redirected nat 1 is no forced swap: the target keeps their card, the caster gets a keep-or-swap", async () => {
    const { caster, target } = await castMark("nat1");
    const targetCard = await forceHold(admin, target.googleSub, "Sleeping Camomile");
    const casterCard = await forceHold(admin, caster.googleSub, "Steady Hand");
    const roundId = await startRound(caster, [target]);

    const drawn = await critAndDraw(target, roundId, "nat1");

    expect(await instance(targetCard)).toEqual({ location: "held", held_by_player: target.googleSub });
    expect(await instance(casterCard)).toEqual({ location: "held", held_by_player: caster.googleSub });
    expect(await instance(drawn.instance_id)).toEqual({ location: "pending_swap", held_by_player: caster.googleSub });
  });

  it("fizzles when the caster's hand is full (held + keep-or-swap): the mark is spent, the target keeps the card", async () => {
    const { caster, target, castId } = await castMark("fizzle");
    const pending = await forceHold(admin, caster.googleSub, "Sleeping Camomile");
    const { error: pErr } = await admin.from("spell_deck_instances").update({ location: "pending_swap" }).eq("id", pending);
    expect(pErr).toBeNull();
    await forceHold(admin, caster.googleSub, "Steady Hand");
    const roundId = await startRound(caster, [target]);

    const drawn = await critAndDraw(target, roundId);

    expect(await instance(drawn.instance_id)).toEqual({ location: "held", held_by_player: target.googleSub });
    const log = await drawLog(drawn.instance_id);
    expect(log.map((r) => r.player_id)).toEqual([target.googleSub]);
    expect(await castInputs(castId)).toMatchObject({
      consumed_by_draw: log[0]!.id,
      draw_redirect_outcome: "fizzled",
    });
  });

  it("fires the oldest live mark first; a later mark waits for the next draw", async () => {
    const { caster: first, target, castId: firstCastId, others } = await castMark("fifo", ["second"]);
    const second = others[0]!;
    const secondRound = await startRound(second, [target, first]);
    const secondCastId = await castBiscuit(second, target, secondRound);
    await resolveInPast(secondRound, 100);

    const roundId = await startRound(first, [target, second]);
    const drawn = await critAndDraw(target, roundId);

    expect(await instance(drawn.instance_id)).toEqual({ location: "held", held_by_player: first.googleSub });
    expect(await castInputs(firstCastId)).toMatchObject({ draw_redirect_outcome: "redirected" });
    expect(await castInputs(secondCastId)).not.toHaveProperty("consumed_by_draw");

    await resolveInPast(roundId, 60);
    const roundId2 = await startRound(first, [target, second]);
    const next = await critAndDraw(target, roundId2);
    expect(await instance(next.instance_id)).toEqual({ location: "held", held_by_player: second.googleSub });
    expect(await castInputs(secondCastId)).toMatchObject({ draw_redirect_outcome: "redirected" });
  });

  it("does not fire before its cast round resolves", async () => {
    const [caster, target] = await Promise.all([signUp("sb-castround-caster"), signUp("sb-castround-target")]);
    // The target earned a draw last round and has not drawn it yet.
    const earlier = await startRound(caster, [target]);
    await recordCrit(target, earlier);
    await resolveInPast(earlier, 60);
    const roundId = await startRound(caster, [target]);
    const castId = await castBiscuit(caster, target, roundId);

    const { data, error } = await target.client.rpc("draw_pending_spell_card", { p_round_id: earlier });
    expect(error).toBeNull();
    const [row] = data as DrawResult[];

    expect(await instance(row!.instance_id)).toEqual({ location: "held", held_by_player: target.googleSub });
    expect(await castInputs(castId)).not.toHaveProperty("consumed_by_draw");
  });

  it("a countered cast leaves no mark", async () => {
    const { caster, target, castId } = await castMark("countered");
    const { error } = await admin.from("spell_casts").update({ negated: true }).eq("id", castId);
    expect(error).toBeNull();
    const roundId = await startRound(caster, [target]);

    const drawn = await critAndDraw(target, roundId);

    expect(await instance(drawn.instance_id)).toEqual({ location: "held", held_by_player: target.googleSub });
    expect(await castInputs(castId)).not.toHaveProperty("consumed_by_draw");
  });

  it("draw_spell_card_as (Test-room puppet): the target's card lands in the caster's hand", async () => {
    const [puppeteer, target] = await Promise.all([signUp("sb-puppet-admin"), signUp("sb-puppet-target")]);
    const { error: adminErr } = await admin.from("players").update({ is_admin: true }).eq("id", puppeteer.googleSub);
    expect(adminErr).toBeNull();
    const roomId = await seedDedicatedRoom(admin, cleanup, [puppeteer.googleSub, target.googleSub], { isTest: true });
    const { castId } = await seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId: target.googleSub,
      casterId: puppeteer.googleSub,
      cardName: "Stale Biscuit",
      effectKind: "draw_redirect",
      effectParams: MARK_PARAMS,
    });

    const { data, error } = await puppeteer.client.rpc("draw_spell_card_as", {
      p_trigger: "nat20",
      p_room_id: roomId,
      p_player_id: target.googleSub,
    });
    expect(error).toBeNull();
    const [row] = data as DrawResult[];

    expect(await instance(row!.instance_id)).toEqual({ location: "held", held_by_player: puppeteer.googleSub });
    expect(await castInputs(castId)).toMatchObject({ draw_redirect_outcome: "redirected" });
  });

  it("admin_proxy_roll: a proxied nat 20 for the target, drawn by the target, goes to the caster", async () => {
    const { caster, target, castId, others } = await castMark("proxy", ["admin"]);
    const adminPlayer = others[0]!;
    const { error: adminErr } = await admin.from("players").update({ is_admin: true }).eq("id", adminPlayer.googleSub);
    expect(adminErr).toBeNull();
    const roundId = await startRound(caster, [target, adminPlayer]);

    const { error: proxyErr } = await adminPlayer.client.rpc("admin_proxy_roll", {
      p_round_id: roundId,
      p_player_id: target.googleSub,
      p_value: 20,
    });
    expect(proxyErr).toBeNull();
    const { data, error } = await target.client.rpc("draw_pending_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    const [row] = data as DrawResult[];

    expect(await instance(row!.instance_id)).toEqual({ location: "held", held_by_player: caster.googleSub });
    expect(await castInputs(castId)).toMatchObject({ draw_redirect_outcome: "redirected" });
  });

  // ==========================================================================
  // Chaining with Marked for Brew
  // ==========================================================================

  it("one crit fires both marks: Marked for Brew hands the draw to A, A's Stale Biscuit sends the card to B", async () => {
    const [target, a, b] = await Promise.all(["target", "a", "b"].map((r) => signUp(`sb-chain-${r}`)));
    const castRound = await startRound(a!, [target!, b!]);
    await forceHold(admin, a!.googleSub, "Marked for Brew");
    const { data: mfbCastId, error: mfbErr } = await a!.client.rpc("cast_spell_card", {
      p_round_id: castRound,
      p_target_player_id: target!.googleSub,
    });
    expect(mfbErr).toBeNull();
    const sbCastId = await castBiscuit(b!, a!, castRound);
    await resolveInPast(castRound, 120);

    const roundId = await startRound(a!, [target!, b!]);
    await recordCrit(target!, roundId);
    const { data, error } = await a!.client.rpc("draw_pending_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    const [row] = data as DrawResult[];

    expect(await instance(row!.instance_id)).toEqual({ location: "held", held_by_player: b!.googleSub });
    expect(await castInputs(mfbCastId as string)).toMatchObject({ draw_redirect_outcome: "redirected" });
    expect(await castInputs(sbCastId)).toMatchObject({ draw_redirect_outcome: "redirected" });
  });

  // ==========================================================================
  // Trace
  // ==========================================================================

  it("traces the mark in its cast round as a next_draw mark", async () => {
    const [caster, target] = await Promise.all([signUp("sb-trace-caster"), signUp("sb-trace-target")]);
    const castRound = await startRound(caster, [target]);
    const castId = await castBiscuit(caster, target, castRound);
    const { error: closeErr } = await caster.client.rpc("close_round", { p_round_id: castRound });
    expect(closeErr).toBeNull();
    for (const [p, v] of [
      [caster.googleSub, 6],
      [target.googleSub, 14],
    ] as const) {
      const { error: rollErr } = await admin
        .from("rolls")
        .insert({ round_id: castRound, player_id: p, layer: 0, value: v, input_mode: "manual", modifier_snapshot: 0 });
      expect(rollErr).toBeNull();
    }
    const { error: resolveErr } = await caster.client.rpc("resolve_round", { p_round_id: castRound });
    expect(resolveErr).toBeNull();

    const marked = await traceSteps(castRound);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({
      target_player: target.googleSub,
      source_cast: { cast_id: castId, card_name: "Stale Biscuit", caster_player_id: caster.googleSub },
      after: { type: "status", value: "marked" },
      outcome: "applied",
      redirect_trigger: "next_draw",
    });
  });
});
