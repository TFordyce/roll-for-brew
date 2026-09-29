import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceRound } from "../../src/app/rounds/advanceRound";
import { enforceStallTimeout } from "../../src/app/rounds/stallEnforcement";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
  stallTimeoutFuture as future,
} from "./setup";

// Runs against a real Supabase stack. Round advancement (ADR 0008, spec #412,
// issue #414): Layer finalization runs as one locked SQL call, finalize_layer,
// behind the advanceRound module's reactionWindowChanged event. Each test
// raises an event (or drives the caller that raises it) as a specific user and
// observes the round's resulting state.
describe.skipIf(!hasAnonTestEnv)("round advancement — Layer finalization (issue #414)", () => {
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

  /** start_round + declare others + close_round; returns the round id. */
  async function openAndCloseRound(starter: Player, others: Player[]): Promise<string> {
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

  async function roundRow(roundId: string) {
    const { data, error } = await admin
      .from("rounds")
      .select("status, brewer_id, current_layer, brewer_modifier_gain, cups_made")
      .eq("id", roundId)
      .single();
    if (error) throw error;
    return data as {
      status: string;
      brewer_id: string | null;
      current_layer: number;
      brewer_modifier_gain: number | null;
      cups_made: number | null;
    };
  }

  async function latestWindowId(roundId: string): Promise<string> {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .select("id")
      .eq("round_id", roundId)
      .order("opened_at", { ascending: false })
      .limit(1)
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  it("a spectator's render recovers a stranded window and the round resolves without error", async () => {
    const [caster, other, spectator] = await Promise.all([
      signUp("adv-spectator-caster"),
      signUp("adv-spectator-other"),
      signUp("adv-spectator-watcher"),
    ]);
    await forceHold(admin, caster.googleSub, "Zariel's Fall"); // Reaction, TABLE, roll_flip

    const roundId = await openAndCloseRound(caster, [other]);
    await caster.client.rpc("submit_roll", { p_round_id: roundId });
    await other.client.rpc("submit_roll", { p_round_id: roundId });

    await caster.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });
    await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });

    // The pre-0104 stranded shape: open, with nobody left eligible to Pass.
    await admin
      .from("spell_reaction_windows")
      .update({ status: "open", closed_at: null })
      .eq("id", await latestWindowId(roundId));

    // The spectator is a room member who never declared in, so isn't an
    // expected roller of layer 0.
    const outcome = await enforceStallTimeout(spectator.client, roundId, future);
    expect(outcome).toEqual({ action: "reactionWindowRecovered" });

    const round = await roundRow(roundId);
    expect(round.status).toBe("resolved");
    expect([caster.googleSub, other.googleSub]).toContain(round.brewer_id);
  });

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

  async function rollsByPlayer(roundId: string, layer = 0): Promise<Map<string, number>> {
    const { data, error } = await admin
      .from("rolls")
      .select("player_id, value")
      .eq("round_id", roundId)
      .eq("layer", layer);
    if (error) throw error;
    return new Map((data as { player_id: string; value: number }[]).map((r) => [r.player_id, r.value]));
  }

  type RollTransform = { kind: string; players: { player_id: string; before: number; after: number }[] };

  async function rollTransformsOf(roundId: string, effectKind: string): Promise<RollTransform[]> {
    const { data, error } = await admin
      .from("spell_casts")
      .select("cast_inputs")
      .eq("round_id", roundId)
      .eq("effect_kind", effectKind);
    if (error) throw error;
    return (data as { cast_inputs: { roll_transform?: RollTransform } | null }[])
      .map((row) => row.cast_inputs?.roll_transform)
      .filter((t): t is RollTransform => Boolean(t));
  }

  /**
   * Seeds layer 0's rolls, opens its reaction window with `caster` as the sole
   * Reaction-card holder (holding `card`), and casts it — which empties
   * eligibility and closes the window (0104). Finalization is left to the test.
   */
  async function castIntoWindow(
    caster: Player,
    other: Player,
    card: string,
    rolls: { caster: number; other: number },
    target: string | null = null,
  ): Promise<string> {
    await forceHold(admin, caster.googleSub, card);
    const roundId = await openAndCloseRound(caster, [other]);
    await seedRoll(roundId, caster.googleSub, rolls.caster);
    await seedRoll(roundId, other.googleSub, rolls.other);

    const { data: opened, error: openError } = await caster.client.rpc("open_reaction_window", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(openError).toBeNull();
    expect((opened as { is_closed: boolean }[])[0]!.is_closed).toBe(false);

    const { error: castError } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();
    return roundId;
  }

  it("reactionWindowChanged while the window is still open is a noop", async () => {
    const [caster, other] = await Promise.all([signUp("adv-open-caster"), signUp("adv-open-other")]);
    await forceHold(admin, caster.googleSub, "Zariel's Fall");
    const roundId = await openAndCloseRound(caster, [other]);
    await seedRoll(roundId, caster.googleSub, 4);
    await seedRoll(roundId, other.googleSub, 15);
    await caster.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });

    const outcome = await advanceRound(other.client, roundId, "reactionWindowChanged");

    expect(outcome).toEqual({ outcome: "noop", reason: "window_open" });
    const round = await roundRow(roundId);
    expect(round.status).toBe("closed");
    expect(round.brewer_id).toBeNull();
    expect(await rollsByPlayer(roundId)).toEqual(
      new Map([
        [caster.googleSub, 4],
        [other.googleSub, 15],
      ]),
    );
  });

  it("reactionWindowChanged at Layer 0 with no window never opens one", async () => {
    const [starter, other] = await Promise.all([signUp("adv-nowin-starter"), signUp("adv-nowin-other")]);
    const roundId = await openAndCloseRound(starter, [other]);
    await seedRoll(roundId, starter.googleSub, 4);
    await seedRoll(roundId, other.googleSub, 15);

    const outcome = await advanceRound(other.client, roundId, "reactionWindowChanged");

    expect(outcome).toEqual({ outcome: "noop", reason: "no_window" });
    const { count } = await admin
      .from("spell_reaction_windows")
      .select("id", { count: "exact", head: true })
      .eq("round_id", roundId);
    expect(count).toBe(0);
    expect((await roundRow(roundId)).status).toBe("closed");
  });

  it("two concurrent reactionWindowChanged calls produce one resolution and one transform record", async () => {
    const [caster, other] = await Promise.all([signUp("adv-race-caster"), signUp("adv-race-other")]);
    const roundId = await castIntoWindow(caster, other, "Zariel's Fall", { caster: 4, other: 15 });

    const outcomes = await Promise.all([
      advanceRound(caster.client, roundId, "reactionWindowChanged"),
      advanceRound(other.client, roundId, "reactionWindowChanged"),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["brewer", "noop"]);
    // Flipped exactly once: a second flip would have restored 4 / 15.
    expect(await rollsByPlayer(roundId)).toEqual(
      new Map([
        [caster.googleSub, 17],
        [other.googleSub, 6],
      ]),
    );
    const transforms = await rollTransformsOf(roundId, "roll_flip");
    expect(transforms).toHaveLength(1);
    expect(transforms[0]!.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ player_id: caster.googleSub, before: 4, after: 17 }),
        expect.objectContaining({ player_id: other.googleSub, before: 15, after: 6 }),
      ]),
    );
    const round = await roundRow(roundId);
    expect(round.status).toBe("resolved");
    expect(round.brewer_id).toBe(other.googleSub);
  });

  it("a Provisional Recap read racing finalize_layer neither deadlocks nor errors", async () => {
    const [caster, other, spectator] = await Promise.all([
      signUp("adv-recap-caster"),
      signUp("adv-recap-other"),
      signUp("adv-recap-watcher"),
    ]);
    const roundId = await castIntoWindow(caster, other, "Zariel's Fall", { caster: 4, other: 15 });

    const recaps = [other, spectator, other, spectator, other, spectator].map((p) =>
      p.client.rpc("get_round_recap", { p_round_id: roundId }),
    );
    const [outcome, ...recapResults] = await Promise.all([
      advanceRound(caster.client, roundId, "reactionWindowChanged"),
      ...recaps,
    ]);

    expect(outcome.outcome).toBe("brewer");
    for (const r of recapResults) expect(r.error?.message ?? null).toBeNull();
    expect((await roundRow(roundId)).status).toBe("resolved");
  });

  it("applies and records a flip at finalization", async () => {
    const [caster, other] = await Promise.all([signUp("adv-flip-caster"), signUp("adv-flip-other")]);
    const roundId = await castIntoWindow(caster, other, "Zariel's Fall", { caster: 3, other: 18 });

    const outcome = await advanceRound(caster.client, roundId, "reactionWindowChanged");

    // 3 / 18 flip to 18 / 3: the other player now brews.
    expect(outcome).toMatchObject({ outcome: "brewer", layer: 0, brewerId: other.googleSub, cupsMade: 2 });
    expect(await rollsByPlayer(roundId)).toEqual(
      new Map([
        [caster.googleSub, 18],
        [other.googleSub, 3],
      ]),
    );
    const [flip] = await rollTransformsOf(roundId, "roll_flip");
    expect(flip!.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ player_id: caster.googleSub, before: 3, after: 18 }),
        expect.objectContaining({ player_id: other.googleSub, before: 18, after: 3 }),
      ]),
    );
  });

  it("applies and records a swap at finalization", async () => {
    const [caster, other] = await Promise.all([signUp("adv-swap-caster"), signUp("adv-swap-other")]);
    const roundId = await castIntoWindow(caster, other, "Dunkin Disaster", { caster: 2, other: 11 });

    const outcome = await advanceRound(caster.client, roundId, "reactionWindowChanged");

    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: other.googleSub });
    expect(await rollsByPlayer(roundId)).toEqual(
      new Map([
        [caster.googleSub, 11],
        [other.googleSub, 2],
      ]),
    );
    const [swap] = await rollTransformsOf(roundId, "roll_swap");
    expect(swap!.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ player_id: caster.googleSub, before: 2, after: 11 }),
        expect.objectContaining({ player_id: other.googleSub, before: 11, after: 2 }),
      ]),
    );
  });

  it("applies and records a chosen-pair transform at finalization", async () => {
    const [caster, other] = await Promise.all([signUp("adv-pair-caster"), signUp("adv-pair-other")]);
    const roundId = await castIntoWindow(caster, other, "Brew-tal Swap", { caster: 5, other: 16 }, other.googleSub);

    const outcome = await advanceRound(other.client, roundId, "reactionWindowChanged");

    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: other.googleSub });
    if (outcome.outcome !== "brewer") throw new Error("expected a brewer");
    expect(outcome.rolls).toEqual(
      expect.arrayContaining([
        { playerId: caster.googleSub, value: 16, discardedValue: null, enteredByAdmin: false },
        { playerId: other.googleSub, value: 5, discardedValue: null, enteredByAdmin: false },
      ]),
    );
    const [pair] = await rollTransformsOf(roundId, "roll_pair_transform");
    expect(pair!.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ player_id: caster.googleSub, before: 5, after: 16 }),
        expect.objectContaining({ player_id: other.googleSub, before: 16, after: 5 }),
      ]),
    );
  });

  it("commits no-modifier-gain (Drip Tray) through finalize_layer", async () => {
    const [caster, other] = await Promise.all([signUp("adv-drip-caster"), signUp("adv-drip-other")]);
    const roundId = await castIntoWindow(caster, other, "Drip Tray", { caster: 9, other: 12 });
    const { data: before } = await admin
      .from("room_players")
      .select("player_id, modifier")
      .eq("room_id", caster.roomId)
      .in("player_id", [caster.googleSub, other.googleSub]);

    const outcome = await advanceRound(caster.client, roundId, "reactionWindowChanged");

    expect(outcome.outcome).toBe("brewer");
    const round = await roundRow(roundId);
    expect(round.status).toBe("resolved");
    expect(round.brewer_modifier_gain).toBe(0);
    const { data: after } = await admin
      .from("room_players")
      .select("player_id, modifier")
      .eq("room_id", caster.roomId)
      .in("player_id", [caster.googleSub, other.googleSub]);
    expect(new Map((after as { player_id: string; modifier: number }[]).map((r) => [r.player_id, r.modifier]))).toEqual(
      new Map((before as { player_id: string; modifier: number }[]).map((r) => [r.player_id, r.modifier])),
    );
  });

  it("commits a declared-number brewer (Inscribed Saucer) through finalize_layer, once", async () => {
    const [caster, target] = await Promise.all([signUp("adv-saucer-caster"), signUp("adv-saucer-target")]);
    await forceHold(admin, caster.googleSub, "Inscribed Saucer");
    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_declared_number: 7,
    });
    expect(castError).toBeNull();
    await caster.client.rpc("close_round", { p_round_id: roundId });
    // The caster's bare 3 would brew; the declared 7 names the target instead.
    await seedRoll(roundId as string, caster.googleSub, 3);
    await seedRoll(roundId as string, target.googleSub, 7);
    const { data: opened } = await caster.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });
    expect((opened as { is_closed: boolean }[])[0]!.is_closed).toBe(true);

    const outcome = await advanceRound(caster.client, roundId as string, "reactionWindowChanged");

    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: target.googleSub });
    expect((await roundRow(roundId as string)).brewer_id).toBe(target.googleSub);
    // Burned with the resolution: the sentinel no longer applies from the next round on.
    const again = await advanceRound(caster.client, roundId as string, "reactionWindowChanged");
    expect(again).toEqual({ outcome: "noop", reason: "round_not_closed" });
  });

  it("records a pending Round Replay (Time for Brew) through finalize_layer", async () => {
    const [caster, other] = await Promise.all([signUp("adv-replay-caster"), signUp("adv-replay-other")]);
    const roundId = await openAndCloseRound(caster, [other]);
    await seedRoll(roundId, caster.googleSub, 6);
    await seedRoll(roundId, other.googleSub, 13);
    const instanceId = await forceHold(admin, caster.googleSub, "Time for Brew");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    const { error: castError } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: caster.googleSub,
      card_instance_id: instanceId,
      target_pending: false,
      effect_kind: "round_replay",
      effect_params: {},
    });
    expect(castError).toBeNull();
    await admin.from("spell_reaction_windows").insert({ round_id: roundId, layer: 0, status: "closed" });

    const outcome = await advanceRound(other.client, roundId, "reactionWindowChanged");

    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: caster.googleSub, replayPending: true });
    const { data: pending } = await admin
      .from("pending_round_replay")
      .select("caster_id")
      .eq("round_id", roundId);
    expect(pending).toEqual([{ caster_id: caster.googleSub }]);
  });

  it("a tied Layer 0 advances to the Tie-Break Reroll Layer with the tied players", async () => {
    const [starter, other] = await Promise.all([signUp("adv-tie-starter"), signUp("adv-tie-other")]);
    const roundId = await openAndCloseRound(starter, [other]);
    await seedRoll(roundId, starter.googleSub, 8);
    await seedRoll(roundId, other.googleSub, 8);
    await admin.from("spell_reaction_windows").insert({ round_id: roundId, layer: 0, status: "closed" });

    const outcome = await advanceRound(other.client, roundId, "reactionWindowChanged");

    expect(outcome).toMatchObject({ outcome: "tie", layer: 1 });
    if (outcome.outcome !== "tie") throw new Error("expected a tie");
    expect([...outcome.tiedPlayerIds].sort()).toEqual([starter.googleSub, other.googleSub].sort());
    const round = await roundRow(roundId);
    expect(round.status).toBe("closed");
    expect(round.current_layer).toBe(1);
  });
});
