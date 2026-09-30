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

type TraceStep = {
  display_kind: string;
  target_player: string | null;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  negated?: boolean;
  heist_reason?: string;
};

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

  /** A closed layer-0 reaction window, so finalize_layer may run. */
  async function closedWindow(roundId: string) {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /**
   * Seeds a Reaction cast row directly (the regression-net seam), spending
   * `instanceId` the way cast_reaction_spell_card does -- back to the deck.
   */
  async function seedReaction(
    roundId: string,
    casterId: string,
    instanceId: string,
    row: { effectKind: string; parentCastId?: string; castInputs?: Record<string, unknown>; windowId: string },
  ) {
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", instanceId);
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: casterId,
        card_instance_id: instanceId,
        target_player_id: null,
        target_pending: false,
        effect_kind: row.effectKind,
        effect_params: {},
        cast_inputs: row.castInputs ?? null,
        parent_cast_id: row.parentCastId ?? null,
        reaction_window_id: row.windowId,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
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

  async function finalize(client: SupabaseClient, roundId: string) {
    const { data, error } = await client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { outcome: string; reason?: string; replay_pending?: boolean };
  }

  /**
   * The final-phase Heist steps. A countered Heist also gets Phase 1's generic
   * negated-victim step (same display_kind, `negated: true`); that one is
   * Phase 1's, not the Heist outcome, so it's left out here.
   */
  async function heistSteps(roundId: string): Promise<TraceStep[]> {
    const { data, error } = await admin.from("rounds").select("resolution_trace").eq("id", roundId).single();
    expect(error).toBeNull();
    return ((data!.resolution_trace ?? []) as TraceStep[]).filter(
      (s) => s.display_kind === "card_heist" && !s.negated,
    );
  }

  /**
   * Thief holds Tea Heist, victim holds `victimCard`; the round is started,
   * the Heist cast pre-roll, and the round is left open.
   */
  async function castHeist(label: string, victimCard = "Lucky Sip", extra: Player[] = []) {
    const [thief, victim] = await Promise.all([signUp(`${label}-thief`), signUp(`${label}-victim`)]);
    const roundId = await startRound(thief, [victim, ...extra]);
    const heistInstance = await forceHold(admin, thief.googleSub, "Tea Heist");
    const loot = await forceHold(admin, victim.googleSub, victimCard);
    const { data: castId, error } = await thief.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: victim.googleSub,
    });
    expect(error).toBeNull();
    return { thief, victim, roundId, heistInstance, loot, castId: castId as string };
  }

  async function rollAll(roundId: string, players: Player[]) {
    let v = 5;
    for (const p of players) await seedRoll(roundId, p.googleSub, v++);
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

  it("a plain steal moves the card at finalize -- not at cast, not on a Provisional Recap view", async () => {
    const { thief, victim, roundId, heistInstance, loot, castId } = await castHeist("heist-plain");

    // Cast: the Tea Heist card is spent, the loot has not moved.
    expect(await instance(heistInstance)).toEqual({ location: "in_deck", held_by_player: null });
    expect(await instance(loot)).toEqual({ location: "held", held_by_player: victim.googleSub });

    await closeRound(thief, roundId);
    await rollAll(roundId, [thief, victim]);
    await closedWindow(roundId);

    // A viewer's Provisional Recap runs the resolver as a dry run: it already
    // says "moved", but moves nothing.
    const { data: recap, error: recapErr } = await victim.client.rpc("get_round_recap", { p_round_id: roundId });
    expect(recapErr).toBeNull();
    const provisional = ((recap as { trace: TraceStep[] }).trace ?? []).filter((s) => s.display_kind === "card_heist");
    expect(provisional.map((s) => s.after.value)).toEqual(["moved"]);
    expect(await instance(loot)).toEqual({ location: "held", held_by_player: victim.googleSub });

    const out = await finalize(thief.client, roundId);
    expect(out.outcome).toBe("brewer");
    expect(await instance(loot)).toEqual({ location: "held", held_by_player: thief.googleSub });

    const [step] = await heistSteps(roundId);
    expect(step).toMatchObject({
      target_player: victim.googleSub,
      source_cast: { cast_id: castId, card_name: "Tea Heist", caster_player_id: thief.googleSub },
      before: { type: "status", value: "held" },
      after: { type: "status", value: "moved" },
      outcome: "applied",
    });
  });

  it("countered: nothing moves and the Trace says countered", async () => {
    const counter = await signUp("heist-ctr-counter");
    const { thief, victim, roundId, loot, castId } = await castHeist("heist-ctr", "Lucky Sip", [counter]);
    await closeRound(thief, roundId);
    await rollAll(roundId, [thief, victim, counter]);
    const windowId = await closedWindow(roundId);
    const tantrum = await forceHold(admin, counter.googleSub, "Tannin Tantrum");
    await seedReaction(roundId, counter.googleSub, tantrum, {
      effectKind: "contested_negate",
      parentCastId: castId,
      castInputs: { dc_d20: 15 },
      windowId,
    });

    await finalize(thief.client, roundId);

    expect(await instance(loot)).toEqual({ location: "held", held_by_player: victim.googleSub });
    const [step] = await heistSteps(roundId);
    expect(step).toMatchObject({ after: { value: "countered" }, outcome: "no-op" });
  });

  it("fizzles when the victim plays the targeted card before rolling", async () => {
    const { thief, victim, roundId, loot } = await castHeist("heist-first");
    const { error } = await victim.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();

    await closeRound(thief, roundId);
    await rollAll(roundId, [thief, victim]);
    await closedWindow(roundId);
    await finalize(thief.client, roundId);

    expect(await instance(loot)).toEqual({ location: "in_deck", held_by_player: null });
    const [step] = await heistSteps(roundId);
    expect(step).toMatchObject({
      after: { value: "fizzled" },
      outcome: "no-op",
      heist_reason: "victim_played_first",
    });
  });

  it("fizzles (not countered) when the victim counters with the targeted card itself", async () => {
    const { thief, victim, roundId, loot, castId } = await castHeist("heist-selfctr", "Tannin Tantrum");
    await closeRound(thief, roundId);
    await rollAll(roundId, [thief, victim]);
    const windowId = await closedWindow(roundId);
    await seedReaction(roundId, victim.googleSub, loot, {
      effectKind: "contested_negate",
      parentCastId: castId,
      castInputs: { dc_d20: 15 },
      windowId,
    });

    await finalize(thief.client, roundId);

    expect(await instance(loot)).toEqual({ location: "in_deck", held_by_player: null });
    const [step] = await heistSteps(roundId);
    expect(step).toMatchObject({ after: { value: "fizzled" }, heist_reason: "victim_played_first" });
  });

  it("a repeated finalize is a no-op and doesn't double-move", async () => {
    const { thief, victim, roundId, loot } = await castHeist("heist-twice");
    await closeRound(thief, roundId);
    await rollAll(roundId, [thief, victim]);
    await closedWindow(roundId);

    const [first, second] = await Promise.all([finalize(thief.client, roundId), finalize(victim.client, roundId)]);
    expect([first.outcome, second.outcome].sort()).toEqual(["brewer", "noop"]);
    expect(await instance(loot)).toEqual({ location: "held", held_by_player: thief.googleSub });
    expect(await heistSteps(roundId)).toHaveLength(1);
  });

  it("lands the loot as a keep-or-swap choice when the thief picked up a card mid-round", async () => {
    const { thief, roundId, loot, victim } = await castHeist("heist-full");
    // A crit draw before the round finalizes refilled the thief's hand.
    const drawn = await forceHold(admin, thief.googleSub, "Tannin Tantrum");

    await closeRound(thief, roundId);
    await rollAll(roundId, [thief, victim]);
    await closedWindow(roundId);
    await finalize(thief.client, roundId);

    expect(await instance(drawn)).toEqual({ location: "held", held_by_player: thief.googleSub });
    expect(await instance(loot)).toEqual({ location: "pending_swap", held_by_player: thief.googleSub });
  });

  // ==========================================================================
  // Replay
  // ==========================================================================

  it("a Time for Brew replay returns the stolen card to the victim; Tea Heist stays spent", async () => {
    const replayer = await signUp("heist-replay-brew");
    const { thief, victim, roundId, heistInstance, loot } = await castHeist("heist-replay", "Lucky Sip", [replayer]);
    await closeRound(thief, roundId);
    await rollAll(roundId, [thief, victim, replayer]);
    const windowId = await closedWindow(roundId);
    const brew = await forceHold(admin, replayer.googleSub, "Time for Brew");
    await seedReaction(roundId, replayer.googleSub, brew, { effectKind: "round_replay", windowId });

    const out = await finalize(thief.client, roundId);
    expect(out.replay_pending).toBe(true);
    expect(await instance(loot)).toEqual({ location: "held", held_by_player: thief.googleSub });

    const { error } = await replayer.client.rpc("confirm_round_replay", { p_round_id: roundId });
    expect(error).toBeNull();

    expect(await instance(loot)).toEqual({ location: "held", held_by_player: victim.googleSub });
    expect(await instance(heistInstance)).toEqual({ location: "in_deck", held_by_player: null });
  });

  it("a replay leaves the card alone once the thief no longer holds it", async () => {
    const replayer = await signUp("heist-gone-brew");
    const { thief, victim, roundId, loot } = await castHeist("heist-replay-gone", "Lucky Sip", [replayer]);
    await closeRound(thief, roundId);
    await rollAll(roundId, [thief, victim, replayer]);
    const windowId = await closedWindow(roundId);
    const brew = await forceHold(admin, replayer.googleSub, "Time for Brew");
    await seedReaction(roundId, replayer.googleSub, brew, { effectKind: "round_replay", windowId });

    await finalize(thief.client, roundId);
    // The thief spends the stolen card before the replay is confirmed.
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", loot);

    const { error } = await replayer.client.rpc("confirm_round_replay", { p_round_id: roundId });
    expect(error).toBeNull();
    expect(await instance(loot)).toEqual({ location: "in_deck", held_by_player: null });
  });
});
