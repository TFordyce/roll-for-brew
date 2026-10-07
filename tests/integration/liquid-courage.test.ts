import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceRound } from "../../src/app/rounds/advanceRound";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Exercises Liquid Courage (issue
// #439, spec #401): "Give another player a d6. In the next 3 rounds they may
// use it as a Reaction to add to their roll."
//
// The gift projects a Courage Token (`courage_token` active effect) on the
// recipient. A live, unspent token is a Reaction Source at Layer 0: the
// recipient is waited on in the Reaction Window and may spend it
// (spend_courage_token), which records a Six Sugars-shaped Pending Spell Die
// on their own roll. "Spent" is derived from that Cast Log row.

type TraceStep = {
  display_kind: string;
  target_player: string | null;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  courage_token?: boolean;
};

const TOKEN_PARAMS = { dice: "1d6", persist: true, participated_rounds_from_cast: 3 };

describe.skipIf(!hasAnonTestEnv)("Liquid Courage (issue #439)", () => {
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

  /** `giver` casts Liquid Courage on `recipient` in `roundId`. */
  async function castGift(giver: Player, recipient: Player, roundId: string) {
    await forceHold(admin, giver.googleSub, "Liquid Courage");
    const { data: castId, error } = await giver.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: recipient.googleSub,
    });
    expect(error).toBeNull();
    return castId as string;
  }

  /** Giver gifts recipient a token in a fresh round, moved 2 hours into the past and resolved. */
  async function gift(label: string, extra: string[] = []) {
    const [giver, recipient, ...others] = await Promise.all(
      ["giver", "recipient", ...extra].map((role) => signUp(`lc-${label}-${role}`)),
    );
    const giftRound = await startRound(giver!, [recipient!, ...others]);
    const castId = await castGift(giver!, recipient!, giftRound);
    await resolveInPast(giftRound, 120);
    return { giver: giver!, recipient: recipient!, others, giftRound, castId };
  }

  async function seedRoll(roundId: string, playerId: string, value: number, discarded: number | null = null) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      discarded_value: discarded,
      input_mode: "manual",
      modifier_snapshot: 0,
    });
    expect(error).toBeNull();
  }

  /** Closes `roundId`, seeds the rolls, and advances: Layer 0's Reaction Window opens. */
  async function openWindow(roundId: string, closer: Player, rolls: [Player, number][]) {
    const { error } = await closer.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
    for (const [p, v] of rolls) await seedRoll(roundId, p.googleSub, v);
    const outcome = await advanceRound(closer.client, roundId, "layerRolled");
    expect(outcome.outcome).toBe("windowOpened");
  }

  async function myTokens(player: Player, roundId: string) {
    const { data, error } = await player.client.rpc("get_my_courage_tokens", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { effect_id: string; giver_player_id: string; giver_display_name: string; dice: string }[];
  }

  async function unspent(roundId: string, playerId: string) {
    const { data, error } = await admin.rpc("_unspent_courage_tokens", { p_round_id: roundId, p_player_id: playerId });
    expect(error).toBeNull();
    return data as { effect_id: string; source_cast_id: string }[];
  }

  async function myWindow(player: Player, roundId: string) {
    const { data, error } = await player.client.rpc("get_open_reaction_window", { p_round_id: roundId });
    expect(error).toBeNull();
    return (data as { layer: number; eligible: boolean; already_passed: boolean }[])[0];
  }

  async function spend(player: Player, roundId: string) {
    const { data, error } = await player.client.rpc("spend_courage_token", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  async function rollDie(player: Player, castId: string, value: number) {
    const { error } = await player.client.rpc("resolve_pending_spell_die_manual", { p_cast_id: castId, p_value: value });
    expect(error).toBeNull();
  }

  async function windowStatus(roundId: string) {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .select("status")
      .eq("round_id", roundId)
      .order("opened_at", { ascending: false })
      .limit(1)
      .single();
    expect(error).toBeNull();
    return data!.status as string;
  }

  async function summaryTotals(roundId: string): Promise<Record<string, number>> {
    const { data, error } = await admin.from("rounds").select("resolution_summary").eq("id", roundId).single();
    expect(error).toBeNull();
    const rows = (data!.resolution_summary ?? []) as { player_id: string; total: number }[];
    return Object.fromEntries(rows.map((r) => [r.player_id, r.total]));
  }

  async function trace(roundId: string): Promise<TraceStep[]> {
    const { data, error } = await admin.from("rounds").select("resolution_trace").eq("id", roundId).single();
    expect(error).toBeNull();
    return (data!.resolution_trace ?? []) as TraceStep[];
  }

  // ==========================================================================
  // The gift
  // ==========================================================================

  it("is un-benched and the gift projects a Courage Token on the recipient", async () => {
    const { giver, recipient, castId } = await gift("projects");

    const { data, error } = await admin
      .from("spell_active_effects")
      .select("target_player_id, caster_id, effect_kind, effect_params, rounds_remaining")
      .eq("source_cast_id", castId);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        target_player_id: recipient.googleSub,
        caster_id: giver.googleSub,
        effect_kind: "courage_token",
        effect_params: TOKEN_PARAMS,
        rounds_remaining: null,
      },
    ]);
  });

  it("the gift round resolves normally; the recipient may spend the new token in that round's window", async () => {
    const [giver, recipient] = await Promise.all([signUp("lc-same-giver"), signUp("lc-same-recipient")]);
    const roundId = await startRound(giver, [recipient]);
    await castGift(giver, recipient, roundId);
    await openWindow(roundId, giver, [
      [recipient, 10],
      [giver, 13],
    ]);

    await rollDie(recipient, await spend(recipient, roundId), 6);
    const outcome = await advanceRound(recipient.client, roundId, "pendingDieResolved");
    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: giver.googleSub });
    expect(await summaryTotals(roundId)).toEqual({ [recipient.googleSub]: 16, [giver.googleSub]: 13 });
    // The gift traces nothing of its own; the spend is the one step.
    expect((await trace(roundId)).map((s) => s.courage_token ?? false)).toEqual([true]);
  });

  // ==========================================================================
  // Prompted with no Reaction card; spend once; the d6 lands
  // ==========================================================================

  it("prompts a recipient with no Reaction card, who spends it once to add 1d6 to their roll", async () => {
    const { giver, recipient } = await gift("spend");
    const roundId = await startRound(giver, [recipient]);
    await openWindow(roundId, giver, [
      [recipient, 10],
      [giver, 13],
    ]);

    // Held no card: the token alone makes them a Reaction Source.
    expect(await myWindow(recipient, roundId)).toMatchObject({ layer: 0, eligible: true, already_passed: false });
    expect(await myWindow(giver, roundId)).toMatchObject({ eligible: false });
    expect(await myTokens(recipient, roundId)).toEqual([
      expect.objectContaining({ giver_player_id: giver.googleSub, dice: "1d6" }),
    ]);

    const spendId = await spend(recipient, roundId);
    const { data: row } = await admin
      .from("spell_casts")
      .select("caster_id, target_player_id, effect_kind, effect_params, target_role")
      .eq("id", spendId)
      .single();
    expect(row).toEqual({
      caster_id: recipient.googleSub,
      target_player_id: recipient.googleSub,
      effect_kind: "dice_modifier",
      effect_params: { dice: "1d6" },
      target_role: "CASTER",
    });

    // Spent: no second spend, nothing left to wait on, the window closes.
    const { error: againErr } = await recipient.client.rpc("spend_courage_token", { p_round_id: roundId });
    expect(againErr).not.toBeNull();
    expect(await myTokens(recipient, roundId)).toEqual([]);
    expect(await windowStatus(roundId)).toBe("closed");

    // The die holds the layer until it's in.
    expect(await advanceRound(giver.client, roundId, "reactionWindowChanged")).toEqual({
      outcome: "noop",
      reason: "layer_incomplete",
    });
    await rollDie(recipient, spendId, 5);
    const outcome = await advanceRound(recipient.client, roundId, "pendingDieResolved");
    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: giver.googleSub });
    expect(await summaryTotals(roundId)).toEqual({ [recipient.googleSub]: 15, [giver.googleSub]: 13 });

    const steps = (await trace(roundId)).filter((s) => s.courage_token);
    expect(steps).toEqual([
      expect.objectContaining({
        target_player: recipient.googleSub,
        source_cast: expect.objectContaining({ cast_id: spendId, card_name: "Liquid Courage" }),
        outcome: "applied",
      }),
    ]);
  });

  it("refuses a spend outside a Layer-0 window or without a token", async () => {
    const { giver, recipient } = await gift("refuse", ["third"]);
    const roundId = await startRound(giver, [recipient]);

    // No window yet.
    const { error: noWindow } = await recipient.client.rpc("spend_courage_token", { p_round_id: roundId });
    expect(noWindow?.code).toBe("RFB04");

    await openWindow(roundId, giver, [
      [recipient, 10],
      [giver, 13],
    ]);
    const { error: noToken } = await giver.client.rpc("spend_courage_token", { p_round_id: roundId });
    expect(noToken?.code).toBe("RFB56");
  });

  it("a token is not a Reaction Source in a tie-break window", async () => {
    const { giver, recipient } = await gift("tiebreak");
    const roundId = await startRound(giver, [recipient]);
    const { error } = await giver.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
    await seedRoll(roundId, recipient.googleSub, 10);
    await seedRoll(roundId, giver.googleSub, 13);
    await admin.from("rounds").update({ current_layer: 1 }).eq("id", roundId);

    const { data: count, error: cErr } = await admin.rpc("_is_reaction_source", {
      p_round_id: roundId,
      p_player_id: recipient.googleSub,
    });
    expect(cErr).toBeNull();
    expect(count).toBe(false);
  });

  // ==========================================================================
  // Skip vote
  // ==========================================================================

  it("a Skip vote counts an unspent token holder as someone being waited on", async () => {
    const { giver, recipient } = await gift("skip");
    const roundId = await startRound(giver, [recipient]);
    await openWindow(roundId, giver, [
      [recipient, 10],
      [giver, 13],
    ]);

    const { data: pending, error } = await giver.client.rpc("get_reaction_window_pending_players", {
      p_round_id: roundId,
    });
    expect(error).toBeNull();
    expect((pending as { player_id: string }[]).map((r) => r.player_id)).toEqual([recipient.googleSub]);

    // Grace over: the giver's Skip vote is the whole table except the one
    // being waited on, so it closes the window.
    await admin
      .from("spell_reaction_windows")
      .update({ poll_round_started_at: new Date(Date.now() - 31_000).toISOString() })
      .eq("round_id", roundId)
      .eq("status", "open");
    const { data: closed, error: vErr } = await giver.client.rpc("vote_skip_reaction_window", { p_round_id: roundId });
    expect(vErr).toBeNull();
    expect(closed).toBe(true);

    // Being skipped costs nothing: the token is still unspent.
    expect(await unspent(roundId, recipient.googleSub)).toHaveLength(1);
  });

  // ==========================================================================
  // After advantage
  // ==========================================================================

  it("adds the d6 after advantage picked the kept d20", async () => {
    const { giver, recipient } = await gift("adv");
    await seedActiveEffect(admin, cleanup, {
      roomId: recipient.roomId,
      targetPlayerId: recipient.googleSub,
      casterId: recipient.googleSub,
      cardName: "Prophe-Tea",
      effectKind: "advantage",
      effectParams: { persist: true },
      roundsRemaining: null,
      roundId: await seedPastRound(recipient.roomId, [giver.googleSub], 110),
    });
    const roundId = await startRound(giver, [recipient]);
    const { error } = await giver.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
    // Kept 11 over 3; the d6 lands on the 11.
    await seedRoll(roundId, recipient.googleSub, 11, 3);
    await seedRoll(roundId, giver.googleSub, 14);
    expect((await advanceRound(giver.client, roundId, "layerRolled")).outcome).toBe("windowOpened");

    await rollDie(recipient, await spend(recipient, roundId), 6);
    const outcome = await advanceRound(recipient.client, roundId, "pendingDieResolved");
    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: giver.googleSub });
    expect((await summaryTotals(roundId))[recipient.googleSub]).toBe(17);

    const kinds = (await trace(roundId))
      .filter((s) => s.target_player === recipient.googleSub)
      .map((s) => (s.courage_token ? "courage" : s.display_kind));
    expect(kinds).toEqual(["advantage", "courage"]);
  });

  // ==========================================================================
  // Lifetime
  // ==========================================================================

  it("lives through the recipient's 3rd round of taking part, counting the gift round and a no-roll round", async () => {
    const { giver, recipient } = await gift("third-round");
    const room = giver.roomId;
    await seedPastRound(room, [giver.googleSub, recipient.googleSub], 100, [giver.googleSub]); // took part, no roll
    await seedPastRound(room, [giver.googleSub], 90); // sat out

    // The live round is the 3rd they take part in.
    const roundId = await startRound(giver, [recipient]);
    expect(await unspent(roundId, recipient.googleSub)).toHaveLength(1);

    const { data: badges, error } = await recipient.client.rpc("get_room_active_effects", { p_room_id: room });
    expect(error).toBeNull();
    expect(badges).toContainEqual(
      expect.objectContaining({ target_player_id: recipient.googleSub, card_name: "Liquid Courage", rounds_remaining: 1 }),
    );
  });

  it("expires after the recipient's 3rd round of taking part", async () => {
    const { giver, recipient } = await gift("fourth-round");
    const room = giver.roomId;
    await seedPastRound(room, [giver.googleSub, recipient.googleSub], 100);
    await seedPastRound(room, [giver.googleSub, recipient.googleSub], 90);

    const roundId = await startRound(giver, [recipient]);
    expect(await unspent(roundId, recipient.googleSub)).toEqual([]);
  });

  // The card says "once in the next 3 rounds", with no day limit (issue #472,
  // Carried Effects): the token follows the recipient into the next day's room
  // and its window keeps counting there.
  it("carries into the next day's room until the recipient has taken part in 3 rounds", async () => {
    const { giver, recipient } = await gift("day-end");
    const tomorrow = await seedDedicatedRoom(admin, cleanup, [giver.googleSub, recipient.googleSub]);
    const first = await seedPastRound(tomorrow, [giver.googleSub, recipient.googleSub], 10);
    // Gift round + nothing yet in tomorrow's room: 1 of 3 used.
    expect(await unspent(first, recipient.googleSub)).toHaveLength(1);

    // Gift round + 2 tomorrow rounds = 3 of 3: spent as of the next round.
    const second = await seedPastRound(tomorrow, [giver.googleSub, recipient.googleSub], 5);
    const third = await seedPastRound(tomorrow, [giver.googleSub, recipient.googleSub], 1);
    expect(await unspent(second, recipient.googleSub)).toHaveLength(1);
    expect(await unspent(third, recipient.googleSub)).toEqual([]);
  });

  // ==========================================================================
  // Not a card
  // ==========================================================================

  it("a spend is invisible to card-targeting Reactions", async () => {
    const { giver, recipient, others } = await gift("not-a-card", ["counter"]);
    const counter = others[0]!;
    await forceHold(admin, counter.googleSub, "Tannin Tantrum"); // Reaction, CARD
    const roundId = await startRound(giver, [recipient, counter]);
    await openWindow(roundId, giver, [
      [recipient, 10],
      [giver, 13],
      [counter, 16],
    ]);
    const spendId = await spend(recipient, roundId);

    const { data: stack, error } = await counter.client.rpc("get_reaction_stack", { p_round_id: roundId });
    expect(error).toBeNull();
    expect((stack as { cast_id: string }[]).map((s) => s.cast_id)).not.toContain(spendId);

    const { error: castErr } = await counter.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: spendId,
    });
    expect(castErr?.message).toMatch(/target cast not found/);
  });

  // ==========================================================================
  // Detox
  // ==========================================================================

  it("Greater Detox ends an unspent token; Lesser Detox can't", async () => {
    const { giver, recipient, others } = await gift("detox", ["detoxer"]);
    const detoxer = others[0]!;
    const roundId = await startRound(giver, [recipient, detoxer]);
    const [token] = await unspent(roundId, recipient.googleSub);

    const lesser = await forceHold(admin, detoxer.googleSub, "Lesser Detox");
    const { error: lesserErr } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: token!.effect_id,
    });
    expect(lesserErr).not.toBeNull();
    expect(await unspent(roundId, recipient.googleSub)).toHaveLength(1);
    // One held card per player: put Lesser Detox back before handing over Greater.
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", lesser);

    await forceHold(admin, detoxer.googleSub, "Greater Detox");
    const { data: offered } = await detoxer.client.rpc("get_dispellable_active_effects", { p_round_id: roundId });
    expect((offered as { effect_id: string }[]).map((r) => r.effect_id)).toContain(token!.effect_id);
    const { error: greaterErr } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: token!.effect_id,
    });
    expect(greaterErr).toBeNull();
    expect(await unspent(roundId, recipient.googleSub)).toEqual([]);
  });

  // ==========================================================================
  // Replay, stacking
  // ==========================================================================

  it("a Time for Brew replay restores a token spent in the scrapped attempt", async () => {
    const { giver, recipient } = await gift("replay");
    const roundId = await startRound(giver, [recipient]);

    const replayInstance = await forceHold(admin, giver.googleSub, "Time for Brew");
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", replayInstance);
    const { error: castErr } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: giver.googleSub,
      card_instance_id: replayInstance,
      target_pending: false,
      effect_kind: "round_replay",
      effect_params: {},
    });
    expect(castErr).toBeNull();

    await openWindow(roundId, giver, [
      [recipient, 10],
      [giver, 13],
    ]);
    await rollDie(recipient, await spend(recipient, roundId), 4);
    expect(await unspent(roundId, recipient.googleSub)).toEqual([]);

    const { error: resolveErr } = await giver.client.rpc("resolve_round", { p_round_id: roundId });
    expect(resolveErr).toBeNull();
    const { error: finalErr } = await giver.client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: giver.googleSub,
      p_cups_made: 2,
    });
    expect(finalErr).toBeNull();
    await giver.client.rpc("record_pending_round_replay", { p_round_id: roundId });
    const { error: confirmErr } = await giver.client.rpc("confirm_round_replay", { p_round_id: roundId });
    expect(confirmErr).toBeNull();

    expect(await unspent(roundId, recipient.googleSub)).toHaveLength(1);
  });

  it("two tokens are independent: each is spent on its own", async () => {
    const { giver, recipient, others } = await gift("two", ["second-giver"]);
    const secondGiver = others[0]!;
    const secondRound = await startRound(secondGiver, [recipient, giver]);
    await castGift(secondGiver, recipient, secondRound);
    await resolveInPast(secondRound, 100);

    const roundId = await startRound(giver, [recipient, secondGiver]);
    await openWindow(roundId, giver, [
      [recipient, 5],
      [giver, 13],
      [secondGiver, 15],
    ]);
    expect((await myTokens(recipient, roundId)).map((t) => t.giver_player_id)).toEqual([
      giver.googleSub,
      secondGiver.googleSub,
    ]);

    const first = await spend(recipient, roundId);
    // Still holding the second: still a Reaction Source, the window stays open.
    expect(await myWindow(recipient, roundId)).toMatchObject({ eligible: true });
    expect((await myTokens(recipient, roundId)).map((t) => t.giver_player_id)).toEqual([secondGiver.googleSub]);
    const second = await spend(recipient, roundId);
    expect(await myTokens(recipient, roundId)).toEqual([]);
    expect(await windowStatus(roundId)).toBe("closed");

    await rollDie(recipient, first, 3);
    await rollDie(recipient, second, 6);
    const outcome = await advanceRound(recipient.client, roundId, "pendingDieResolved");
    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: giver.googleSub });
    expect((await summaryTotals(roundId))[recipient.googleSub]).toBe(14);
  });
});
