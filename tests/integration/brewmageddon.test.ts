import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceRound } from "../../src/app/rounds/advanceRound";
import { enforceStallTimeout } from "../../src/app/rounds/stallEnforcement";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
  stallTimeoutFuture as future,
} from "./setup";

// Runs against a real Supabase stack. Issue #440 (spec #401, design #385):
// Brewmageddon compels every participant holding a card at close_round to
// play it this round. Action holders cast in a Compelled Cast step that holds
// all rolling; Reaction holders must cast in the Layer-0 Reaction Window and
// cannot pass it. An unmet obligation is Forfeited: the card goes back to the
// deck and a no-effect `forfeit` Cast Log row points at Brewmageddon.
describe.skipIf(!hasAnonTestEnv)("Brewmageddon: Compelled Cast and Forfeit (issue #440)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  type Player = Awaited<ReturnType<typeof signUpSignInAndEnterRoom>>;

  /** Signs up the players into their own room so no stranger joins the round. */
  async function players<const L extends readonly string[]>(...labels: L): Promise<{ [K in keyof L]: Player }> {
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `bm-${l}`)));
    const roomId = await seedDedicatedRoom(
      admin,
      cleanup,
      ps.map((p) => p.googleSub),
    );
    return ps.map((p) => ({ ...p, roomId })) as { [K in keyof L]: Player };
  }

  /** start_round in the players' room, and everyone else declares in. */
  async function openRound(starter: Player, others: Player[]): Promise<string> {
    const { data: roundId, error } = await starter.client.rpc("start_round", { p_room_id: starter.roomId });
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function castBrewmageddon(caster: Player, roundId: string): Promise<string> {
    await forceHold(admin, caster.googleSub, "Brewmageddon");
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  async function close(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function castRows(roundId: string) {
    const { data, error } = await admin
      .from("spell_casts")
      .select("id, caster_id, effect_kind, target_player_id, cast_inputs, card_instance_id")
      .eq("round_id", roundId)
      .order("seq");
    if (error) throw error;
    return data as {
      id: string;
      caster_id: string;
      effect_kind: string | null;
      target_player_id: string | null;
      cast_inputs: Record<string, unknown> | null;
      card_instance_id: string;
    }[];
  }

  async function forfeits(roundId: string) {
    return (await castRows(roundId))
      .filter((c) => c.effect_kind === "forfeit")
      .map((c) => ({ player: c.caster_id, reason: c.cast_inputs?.reason, compelledBy: c.cast_inputs?.compelled_by }));
  }

  async function heldBy(playerId: string): Promise<string[]> {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("location")
      .eq("held_by_player", playerId);
    if (error) throw error;
    return (data as { location: string }[]).map((r) => r.location);
  }

  async function step(p: Player, roundId: string) {
    const { data, error } = await p.client.rpc("get_compelled_cast_step", { p_round_id: roundId });
    expect(error).toBeNull();
    return (data as { waiting_on: string[]; ended_at: string | null }[])[0]!;
  }

  async function isExpectedRoller(p: Player, roundId: string) {
    const { data, error } = await p.client.rpc("is_expected_layer_roller", {
      p_round_id: roundId,
      p_player_id: p.googleSub,
      p_layer: 0,
    });
    expect(error).toBeNull();
    return data as boolean;
  }

  async function roundRow(roundId: string) {
    const { data, error } = await admin
      .from("rounds")
      .select("status, resolution_trace")
      .eq("id", roundId)
      .single();
    if (error) throw error;
    return data as { status: string; resolution_trace: { display_kind: string; [k: string]: unknown }[] | null };
  }

  /** Every roller rolls via the real RPC (random values). */
  async function rollAll(roundId: string, rollers: Player[]) {
    for (const p of rollers) {
      const { error } = await p.client.rpc("submit_roll", { p_round_id: roundId });
      expect(error).toBeNull();
    }
  }

  /**
   * Seeds distinct Layer-0 rolls (no tie, and none after a Zariel's Fall flip
   * either), for tests about what happens after rolling, not the rolling.
   */
  async function seedRolls(roundId: string, rollers: Player[]) {
    const values = [4, 15, 10, 7];
    for (const [i, p] of rollers.entries()) {
      const { error } = await admin.from("rolls").insert({
        round_id: roundId,
        player_id: p.googleSub,
        layer: 0,
        value: values[i],
        input_mode: "manual",
        modifier_snapshot: 0,
      });
      expect(error).toBeNull();
    }
  }

  async function windowStatus(roundId: string): Promise<string | null> {
    const { data } = await admin
      .from("spell_reaction_windows")
      .select("status")
      .eq("round_id", roundId)
      .maybeSingle();
    return (data as { status: string } | null)?.status ?? null;
  }

  // ------------------------------------------------------------------------
  // Compelled Cast step (Action cards)
  // ------------------------------------------------------------------------

  it("holds all rolling until every compelled Action cast is in, and an adv cast made in the step takes effect", async () => {
    const [caster, holder, bystander] = await players("step-caster", "step-holder", "step-bystander");
    await forceHold(admin, holder.googleSub, "Sugar Rush"); // Action / SELF advantage
    const roundId = await openRound(caster, [holder, bystander]);
    const bmCastId = await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    expect((await step(bystander, roundId)).waiting_on).toEqual([holder.googleSub]);
    expect(await isExpectedRoller(bystander, roundId)).toBe(false);
    const { error: rollErr } = await bystander.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr?.code).toBe("RFB02");

    // The compelled cast is accepted while the round is closed.
    const { error: castErr } = await holder.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const adv = (await castRows(roundId)).find((c) => c.effect_kind === "advantage")!;
    expect(adv.cast_inputs?.compelled_by).toBe(bmCastId);
    expect(await heldBy(holder.googleSub)).toEqual([]);

    const s = await step(bystander, roundId);
    expect(s.waiting_on).toEqual([]);
    expect(s.ended_at).not.toBeNull();
    expect(await isExpectedRoller(bystander, roundId)).toBe(true);

    await rollAll(roundId, [caster, holder, bystander]);
    const { data: holderRoll } = await admin
      .from("rolls")
      .select("discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", holder.googleSub)
      .single();
    // Advantage rolled two dice: the lower one was discarded.
    expect((holderRoll as { discarded_value: number | null }).discarded_value).not.toBeNull();
  });

  it("refuses a compelled cast with a deferred target, and accepts one naming its target now", async () => {
    const [caster, holder] = await players("defer-caster", "defer-holder");
    await forceHold(admin, holder.googleSub, "Fortune's Flavour"); // Action / PLAYER advantage
    const roundId = await openRound(caster, [holder]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    const { error: deferErr } = await holder.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(deferErr?.code).toBe("RFB53");
    expect(await heldBy(holder.googleSub)).toEqual(["held"]);

    const { error } = await holder.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: holder.googleSub,
    });
    expect(error).toBeNull();
    expect((await step(caster, roundId)).waiting_on).toEqual([]);
  });

  it("a player who owes nothing still cannot cast while the round is closed", async () => {
    const [caster, holder, late] = await players("owe-caster", "owe-holder", "owe-late");
    await forceHold(admin, holder.googleSub, "Sugar Rush");
    const roundId = await openRound(caster, [holder]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    // Declared in after close: not in the compelled set, so no closed-round cast.
    const { error: lateErr } = await late.client.rpc("declare_in_late", { p_round_id: roundId });
    expect(lateErr).toBeNull();
    await forceHold(admin, late.googleSub, "Lucky Sip");
    const { error } = await late.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error?.code).toBe("RFB03");
  });

  // ------------------------------------------------------------------------
  // Forfeit triggers
  // ------------------------------------------------------------------------

  it("forfeits a compelled Action card with no legal target when the set is fixed", async () => {
    // Two participants: Stir the Pot needs two OTHER players; Greater Detox
    // (a third player's) needs an active effect to end -- there is none.
    const [caster, stirrer, detoxer] = await players("nlt-caster", "nlt-stirrer", "nlt-detoxer");
    await forceHold(admin, stirrer.googleSub, "Stir the Pot");
    await forceHold(admin, detoxer.googleSub, "Greater Detox");
    const roundId = await openRound(caster, [stirrer, detoxer]);
    const bmCastId = await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    // Three participants: Stir the Pot has exactly two others, so it is legal.
    expect(await forfeits(roundId)).toEqual([
      { player: detoxer.googleSub, reason: "no_legal_target", compelledBy: bmCastId },
    ]);
    expect(await heldBy(detoxer.googleSub)).toEqual([]);
    expect((await step(caster, roundId)).waiting_on).toEqual([stirrer.googleSub]);
  });

  it("forfeits Stir the Pot in a two-player round, and rolling opens at once", async () => {
    const [caster, stirrer] = await players("nlt2-caster", "nlt2-stirrer");
    await forceHold(admin, stirrer.googleSub, "Stir the Pot");
    const roundId = await openRound(caster, [stirrer]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    expect((await forfeits(roundId)).map((f) => f.reason)).toEqual(["no_legal_target"]);
    expect(await isExpectedRoller(stirrer, roundId)).toBe(true);
  });

  it("stall: forfeits outstanding compelled Action casts, excludes nobody, then restarts the roll clock", async () => {
    const [caster, holder, bystander] = await players("stall-caster", "stall-holder", "stall-bystander");
    await forceHold(admin, holder.googleSub, "Sugar Rush");
    const roundId = await openRound(caster, [holder, bystander]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    // Age the round so the 5-minute clock has run out on the step.
    const { error: ageErr } = await admin
      .from("rounds")
      .update({ closed_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .eq("id", roundId);
    expect(ageErr).toBeNull();

    const outcome = await enforceStallTimeout(bystander.client, roundId);
    expect(outcome).toEqual({ action: "compelledCastsForfeited", playerIds: [holder.googleSub] });
    expect((await forfeits(roundId)).map((f) => f.reason)).toEqual(["stall"]);

    const { data: excluded } = await admin
      .from("round_participants")
      .select("player_id")
      .eq("round_id", roundId)
      .not("excluded_at", "is", null);
    expect(excluded).toEqual([]);

    // Rolling is open, and its stall clock runs from the step's end, not
    // closed_at: nobody is excluded for not having rolled yet.
    expect(await isExpectedRoller(bystander, roundId)).toBe(true);
    expect(await enforceStallTimeout(bystander.client, roundId)).toEqual({ action: "none" });
  });

  // ------------------------------------------------------------------------
  // Reaction cards
  // ------------------------------------------------------------------------

  /** BM cast, close, everyone rolls, advance: the Layer-0 window opens. */
  async function roundWithOpenWindow(caster: Player, others: Player[]) {
    const roundId = await openRound(caster, others);
    const bmCastId = await castBrewmageddon(caster, roundId);
    await close(caster, roundId);
    await seedRolls(roundId, [caster, ...others]);
    const outcome = await advanceRound(caster.client, roundId, "layerRolled");
    expect(outcome.outcome).toBe("windowOpened");
    return { roundId, bmCastId };
  }

  it("a compelled Reaction holder cannot pass the Layer-0 window, and their cast counts", async () => {
    const [caster, holder, bystander] = await players("rx-caster", "rx-holder", "rx-bystander");
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const { roundId, bmCastId } = await roundWithOpenWindow(caster, [holder, bystander]);

    const { error: passErr } = await holder.client.rpc("pass_reaction_window", { p_round_id: roundId });
    expect(passErr?.code).toBe("RFB53");
    expect(await windowStatus(roundId)).toBe("open");

    const { error } = await holder.client.rpc("cast_reaction_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    const flip = (await castRows(roundId)).find((c) => c.effect_kind === "roll_flip")!;
    expect(flip.cast_inputs?.compelled_by).toBe(bmCastId);

    await advanceRound(caster.client, roundId, "reactionWindowChanged");
    expect((await roundRow(roundId)).status).toBe("resolved");
  });

  it("a compelled Reaction holder skipped by vote forfeits their card", async () => {
    const [caster, holder, bystander] = await players("vote-caster", "vote-holder", "vote-bystander");
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const { roundId, bmCastId } = await roundWithOpenWindow(caster, [holder, bystander]);

    await admin
      .from("spell_reaction_windows")
      .update({ poll_round_started_at: new Date(Date.now() - 31_000).toISOString() })
      .eq("round_id", roundId);
    for (const voter of [caster, bystander]) {
      const { error } = await voter.client.rpc("vote_skip_reaction_window", { p_round_id: roundId });
      expect(error).toBeNull();
    }
    expect(await windowStatus(roundId)).toBe("closed");
    expect(await forfeits(roundId)).toEqual([{ player: holder.googleSub, reason: "vote", compelledBy: bmCastId }]);
    expect(await heldBy(holder.googleSub)).toEqual([]);
  });

  it("a compelled Reaction holder timed out by the stall backstop forfeits their card", async () => {
    const [caster, holder] = await players("to-caster", "to-holder");
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const { roundId } = await roundWithOpenWindow(caster, [holder]);

    const outcome = await enforceStallTimeout(caster.client, roundId, future);
    expect(outcome).toEqual({ action: "reactionWindowTimedOut", playerIds: [holder.googleSub] });
    expect((await forfeits(roundId)).map((f) => f.reason)).toEqual(["timeout"]);
    expect((await roundRow(roundId)).status).toBe("resolved");
  });

  it("a compelled Reaction holder excluded for never rolling forfeits their card", async () => {
    const [caster, holder, bystander] = await players("ex-caster", "ex-holder", "ex-bystander");
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const roundId = await openRound(caster, [holder, bystander]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);
    await seedRolls(roundId, [caster, bystander]);

    const outcome = await enforceStallTimeout(caster.client, roundId, future);
    expect(outcome).toEqual({ action: "excluded", playerIds: [holder.googleSub] });
    expect((await forfeits(roundId)).map((f) => f.reason)).toEqual(["excluded"]);
    expect(await heldBy(holder.googleSub)).toEqual([]);
  });

  it("Brewmageddon countered: the earlier compelled cast stands and pending Reaction holders are released", async () => {
    const [caster, actor, counterer, holder] = await players("ctr-caster", "ctr-actor", "ctr-counterer", "ctr-holder");
    await forceHold(admin, actor.googleSub, "Sugar Rush");
    await forceHold(admin, counterer.googleSub, "Tannin Tantrum");
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const roundId = await openRound(caster, [actor, counterer, holder]);
    const bmCastId = await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    const { error: actErr } = await actor.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(actErr).toBeNull();
    // The actor rolls for real so their advantage is recorded.
    await rollAll(roundId, [actor]);
    await seedRolls(roundId, [caster, counterer, holder]);
    expect((await advanceRound(caster.client, roundId, "layerRolled")).outcome).toBe("windowOpened");

    // Brewmageddon is on the stack as a CARD target.
    const { data: stack } = await counterer.client.rpc("get_reaction_stack", { p_round_id: roundId });
    expect((stack as { cast_id: string }[]).map((e) => e.cast_id)).toContain(bmCastId);

    const { data: counterId, error: ctrErr } = await counterer.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_cast_id: bmCastId,
    });
    expect(ctrErr).toBeNull();
    // Pin the contest so the counter lands (its d20 is cast-time RNG).
    const { data: ctr } = await admin.from("spell_casts").select("cast_inputs").eq("id", counterId).single();
    const inputs = { ...((ctr as { cast_inputs: Record<string, unknown> }).cast_inputs ?? {}), dc_d20: 20 };
    delete (inputs as Record<string, unknown>).backfire;
    await admin.from("spell_casts").update({ cast_inputs: inputs }).eq("id", counterId);

    // Released: the Reaction holder may now pass.
    const { error: passErr } = await holder.client.rpc("pass_reaction_window", { p_round_id: roundId });
    expect(passErr).toBeNull();
    expect(await heldBy(holder.googleSub)).toEqual(["held"]);

    // Layer 0 finalizes (the real roll may tie into a Tie-Break Reroll);
    // resolve_round has written the Cast Log's negation either way.
    const outcome = await advanceRound(caster.client, roundId, "reactionWindowChanged");
    expect(["brewer", "tie"]).toContain(outcome.outcome);
    const { data: flags } = await admin
      .from("spell_casts")
      .select("effect_kind, negated")
      .eq("round_id", roundId);
    const byKind = new Map((flags as { effect_kind: string; negated: boolean }[]).map((f) => [f.effect_kind, f.negated]));
    expect(byKind.get("compel_cast")).toBe(true);
    // The compelled Sugar Rush still stands.
    expect(byKind.get("advantage")).toBe(false);
    expect(await forfeits(roundId)).toEqual([]);
  });

  // ------------------------------------------------------------------------
  // No holders, replay, Recap
  // ------------------------------------------------------------------------

  it("with nobody holding a card it is a no-op: rolling opens at close and the Trace says so", async () => {
    const [caster, other] = await players("noop-caster", "noop-other");
    const roundId = await openRound(caster, [other]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    expect(await isExpectedRoller(other, roundId)).toBe(true);
    await seedRolls(roundId, [caster, other]);
    await advanceRound(caster.client, roundId, "layerRolled");

    const round = await roundRow(roundId);
    expect(round.status).toBe("resolved");
    const compel = round.resolution_trace!.find((s) => s.display_kind === "compel_cast");
    expect(compel).toMatchObject({ outcome: "no-op", compelled_player_ids: [] });
  });

  it("the Trace and the Recap link compelled casts and Forfeits to Brewmageddon", async () => {
    const [caster, actor, detoxer] = await players("rc-caster", "rc-actor", "rc-detoxer");
    await forceHold(admin, actor.googleSub, "Sugar Rush");
    await forceHold(admin, detoxer.googleSub, "Greater Detox");
    const roundId = await openRound(caster, [actor, detoxer]);
    const bmCastId = await castBrewmageddon(caster, roundId);
    await close(caster, roundId);
    await actor.client.rpc("cast_spell_card", { p_round_id: roundId });
    await seedRolls(roundId, [caster, actor, detoxer]);
    await advanceRound(caster.client, roundId, "layerRolled");

    const trace = (await roundRow(roundId)).resolution_trace!;
    expect(trace.find((s) => s.display_kind === "compel_cast")).toMatchObject({
      outcome: "applied",
      compelled_player_ids: [actor.googleSub, detoxer.googleSub].sort(),
    });
    expect(trace.find((s) => s.display_kind === "forfeit")).toMatchObject({
      target_player: detoxer.googleSub,
      outcome: "no-op",
      reason: "no_legal_target",
      compelled_by: bmCastId,
    });

    const { data, error } = await caster.client.rpc("get_round_recap", { p_round_id: roundId });
    expect(error).toBeNull();
    const casts = (data as { casts: { card_name: string; compelled_by_cast_id: string | null }[] }).casts;
    expect(casts.find((c) => c.card_name === "Sugar Rush")?.compelled_by_cast_id).toBe(bmCastId);
    expect(casts.find((c) => c.card_name === "Greater Detox")?.compelled_by_cast_id).toBe(bmCastId);
    expect(casts.find((c) => c.card_name === "Brewmageddon")?.compelled_by_cast_id).toBeNull();
  });

  it("does not re-fire on a Time for Brew replay", async () => {
    const [caster, holder] = await players("rep-caster", "rep-holder");
    await forceHold(admin, holder.googleSub, "Sugar Rush");
    const roundId = await openRound(caster, [holder]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);
    await holder.client.rpc("cast_spell_card", { p_round_id: roundId });
    await seedRolls(roundId, [caster, holder]);

    // A surviving Time for Brew, seeded onto the resolving round.
    const tfb = await forceHold(admin, caster.googleSub, "Time for Brew");
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", tfb);
    const { error: tfbErr } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: caster.googleSub,
      card_instance_id: tfb,
      effect_kind: "round_replay",
      effect_params: {},
    });
    expect(tfbErr).toBeNull();
    await advanceRound(caster.client, roundId, "layerRolled");
    expect((await roundRow(roundId)).status).toBe("resolved");

    const { error: confErr } = await caster.client.rpc("confirm_round_replay", { p_round_id: roundId });
    expect(confErr).toBeNull();
    expect((await roundRow(roundId)).status).toBe("closed");

    // Generation 1: no compulsion, so rolling is open straight away, and the
    // compelled card stays spent.
    expect((await step(caster, roundId)).waiting_on).toEqual([]);
    expect(await isExpectedRoller(caster, roundId)).toBe(true);
    expect((await castRows(roundId)).some((c) => c.effect_kind === "compel_cast" || c.effect_kind === "forfeit")).toBe(false);
    expect(await heldBy(holder.googleSub)).toEqual([]);
  });
});
