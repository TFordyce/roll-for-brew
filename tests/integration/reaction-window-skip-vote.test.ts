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

// Runs against a real Supabase stack. Issue #411: an eligible Reaction-card
// holder who never passes must not hold a round open forever. The table can
// Skip vote once 30 seconds have passed since the current poll round started,
// and the 5-minute stall timer is the backstop, counted from the latest poll
// round start rather than rounds.closed_at.
describe.skipIf(!hasAnonTestEnv)("reaction window skip vote and stall backstop (issue #411)", () => {
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

  /**
   * Start, declare, close, seed distinct rolls (so no round ties), then
   * advance: Layer 0's reaction window is open.
   */
  async function roundWithOpenWindow(starter: Player, others: Player[]): Promise<string> {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    const { error: cErr } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(cErr).toBeNull();
    const values = [4, 15, 10, 7];
    for (const [i, p] of [starter, ...others].entries()) {
      const { error: rErr } = await admin.from("rolls").insert({
        round_id: roundId,
        player_id: p.googleSub,
        layer: 0,
        value: values[i],
        input_mode: "manual",
        modifier_snapshot: 0,
      });
      expect(rErr).toBeNull();
    }
    const outcome = await advanceRound(starter.client, roundId as string, "layerRolled");
    expect(outcome.outcome).toBe("windowOpened");
    return roundId as string;
  }

  async function roundStatus(roundId: string): Promise<string> {
    const { data, error } = await admin.from("rounds").select("status").eq("id", roundId).single();
    if (error) throw error;
    return (data as { status: string }).status;
  }

  async function windowRow(roundId: string) {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .select("id, status, poll_round")
      .eq("round_id", roundId)
      .order("opened_at", { ascending: false })
      .limit(1)
      .single();
    if (error) throw error;
    return data as { id: string; status: string; poll_round: number };
  }

  /** Moves the open window's poll round start into the past, so the grace period (or the backstop) is over. */
  async function agePollRound(roundId: string, ageMs: number) {
    const { error } = await admin
      .from("spell_reaction_windows")
      .update({ poll_round_started_at: new Date(Date.now() - ageMs).toISOString() })
      .eq("round_id", roundId)
      .eq("status", "open");
    expect(error).toBeNull();
  }

  const PAST_GRACE = 31_000;

  function vote(p: Player, roundId: string) {
    return p.client.rpc("vote_skip_reaction_window", { p_round_id: roundId });
  }

  async function recapSkips(p: Player, roundId: string) {
    const { data, error } = await p.client.rpc("get_round_recap", { p_round_id: roundId });
    expect(error).toBeNull();
    return (data as { reaction_skips: { player_id: string; reason: string }[] }).reaction_skips;
  }

  it("stall backstop: a silent Reaction holder is auto-passed 5 minutes after the poll round started and the round resolves", async () => {
    const [holder, other] = await Promise.all([signUp("skip-stall-holder"), signUp("skip-stall-other")]);
    await forceHold(admin, holder.googleSub, "Zariel's Fall"); // Reaction

    const roundId = await roundWithOpenWindow(holder, [other]);

    const outcome = await enforceStallTimeout(other.client, roundId, future);
    expect(outcome).toEqual({ action: "reactionWindowTimedOut", playerIds: [holder.googleSub] });
    expect(await roundStatus(roundId)).toBe("resolved");
    expect(await recapSkips(other, roundId)).toEqual([{ player_id: holder.googleSub, reason: "timeout" }]);
  });

  it("2 participants: after the grace period the other votes, the window closes and the round resolves", async () => {
    const [holder, other] = await Promise.all([signUp("skip-2p-holder"), signUp("skip-2p-other")]);
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const roundId = await roundWithOpenWindow(holder, [other]);
    await agePollRound(roundId, PAST_GRACE);

    const { data: closed, error } = await vote(other, roundId);
    expect(error).toBeNull();
    expect(closed).toBe(true);
    expect((await windowRow(roundId)).status).toBe("closed");

    const outcome = await advanceRound(other.client, roundId, "reactionWindowChanged");
    expect(outcome.outcome).toBe("brewer");
    expect(await roundStatus(roundId)).toBe("resolved");

    // Being skipped costs nothing: the card is still held.
    const { data: held } = await admin
      .from("spell_deck_instances")
      .select("location")
      .eq("held_by_player", holder.googleSub);
    expect((held as { location: string }[]).map((r) => r.location)).toEqual(["held"]);

    expect(await recapSkips(holder, roundId)).toEqual([{ player_id: holder.googleSub, reason: "vote" }]);
  });

  it("rejects a vote inside the 30-second grace period", async () => {
    const [holder, other] = await Promise.all([signUp("skip-grace-holder"), signUp("skip-grace-other")]);
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const roundId = await roundWithOpenWindow(holder, [other]);

    const { error } = await vote(other, roundId);
    expect(error?.code).toBe("RFB51");
    expect((await windowRow(roundId)).status).toBe("open");

    const { data: state } = await other.client.rpc("get_reaction_window_skip_vote", { p_round_id: roundId });
    expect(state).toEqual([
      expect.objectContaining({ votes: 0, threshold: 1, has_voted: false, can_vote: true, waited_on: false }),
    ]);
  });

  it("the player being waited on, a spectator and a stall-excluded participant can't vote", async () => {
    const [holder, a, excluded, spectator] = await Promise.all([
      signUp("skip-who-holder"),
      signUp("skip-who-a"),
      signUp("skip-who-excluded"),
      signUp("skip-who-spectator"),
    ]);
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const roundId = await roundWithOpenWindow(holder, [a, excluded]);
    await admin
      .from("round_participants")
      .update({ excluded_at: new Date().toISOString() })
      .eq("round_id", roundId)
      .eq("player_id", excluded.googleSub);
    await agePollRound(roundId, PAST_GRACE);

    for (const p of [holder, spectator, excluded]) {
      const { error } = await vote(p, roundId);
      expect(error?.code).toBe("RFB52");
    }
    expect((await windowRow(roundId)).status).toBe("open");

    const { data: holderState } = await holder.client.rpc("get_reaction_window_skip_vote", { p_round_id: roundId });
    expect(holderState).toEqual([expect.objectContaining({ can_vote: false, waited_on: true })]);
  });

  it("4 participants, 1 being waited on: the 1st vote doesn't skip, the 2nd does; a repeat vote is a no-op", async () => {
    const [holder, a, b, c] = await Promise.all([
      signUp("skip-4p-holder"),
      signUp("skip-4p-a"),
      signUp("skip-4p-b"),
      signUp("skip-4p-c"),
    ]);
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const roundId = await roundWithOpenWindow(holder, [a, b, c]);
    await agePollRound(roundId, PAST_GRACE);

    expect((await vote(a, roundId)).data).toBe(false);
    const again = await vote(a, roundId);
    expect(again.error).toBeNull();
    expect(again.data).toBe(false);
    expect((await windowRow(roundId)).status).toBe("open");

    const { data: state } = await b.client.rpc("get_reaction_window_skip_vote", { p_round_id: roundId });
    expect(state).toEqual([expect.objectContaining({ votes: 1, threshold: 2, has_voted: false })]);

    expect((await vote(b, roundId)).data).toBe(true);
    expect((await windowRow(roundId)).status).toBe("closed");
  });

  it("a chained Reaction cast discards the votes so far and restarts the grace period", async () => {
    const [holder, chainer, a, b] = await Promise.all([
      signUp("skip-chain-holder"),
      signUp("skip-chain-chainer"),
      signUp("skip-chain-a"),
      signUp("skip-chain-b"),
    ]);
    await forceHold(admin, holder.googleSub, "Mug Shot"); // Reaction, Opponent
    await forceHold(admin, chainer.googleSub, "Zariel's Fall"); // Reaction, TABLE
    const roundId = await roundWithOpenWindow(holder, [chainer, a, b]);
    await agePollRound(roundId, PAST_GRACE);

    expect((await vote(a, roundId)).data).toBe(false);

    const { error: castError } = await chainer.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();
    expect((await windowRow(roundId)).poll_round).toBe(2);

    const { error: earlyError } = await vote(b, roundId);
    expect(earlyError?.code).toBe("RFB51");

    const { data: state } = await a.client.rpc("get_reaction_window_skip_vote", { p_round_id: roundId });
    expect(state).toEqual([expect.objectContaining({ votes: 0, has_voted: false })]);
  });

  it("4 participants, 3 silent holders: one vote can't skip, and the stall backstop auto-passes them", async () => {
    const [h1, h2, h3, voter] = await Promise.all([
      signUp("skip-maj-h1"),
      signUp("skip-maj-h2"),
      signUp("skip-maj-h3"),
      signUp("skip-maj-voter"),
    ]);
    // One deck instance per card, so each holder needs a different Reaction card.
    await forceHold(admin, h1.googleSub, "Zariel's Fall");
    await forceHold(admin, h2.googleSub, "Mug Shot");
    await forceHold(admin, h3.googleSub, "Brew-tal Swap");
    const roundId = await roundWithOpenWindow(h1, [h2, h3, voter]);
    await agePollRound(roundId, PAST_GRACE);

    expect((await vote(voter, roundId)).data).toBe(false);

    const outcome = await enforceStallTimeout(voter.client, roundId, future);
    expect(outcome).toMatchObject({ action: "reactionWindowTimedOut" });
    expect([...(outcome as { playerIds: string[] }).playerIds].sort()).toEqual(
      [h1.googleSub, h2.googleSub, h3.googleSub].sort(),
    );
    expect(await roundStatus(roundId)).toBe("resolved");
  });

  it("the backstop counts from the latest poll round, not closed_at", async () => {
    const [holder, other] = await Promise.all([signUp("skip-clock-holder"), signUp("skip-clock-other")]);
    await forceHold(admin, holder.googleSub, "Zariel's Fall");
    const roundId = await roundWithOpenWindow(holder, [other]);
    await admin
      .from("rounds")
      .update({ closed_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .eq("id", roundId);
    await agePollRound(roundId, 60_000);

    const outcome = await enforceStallTimeout(other.client, roundId);
    expect(outcome).toEqual({ action: "none" });
    expect((await windowRow(roundId)).status).toBe("open");
  });

  it("an outstanding Reaction-timed Pending Spell Die still blocks after a skip; resolving it advances the round", async () => {
    const [caster, holder] = await Promise.all([signUp("skip-die-caster"), signUp("skip-die-holder")]);
    await forceHold(admin, caster.googleSub, "Six Sugars"); // Reaction, Self, dice_modifier 1d6
    await forceHold(admin, holder.googleSub, "Mug Shot"); // Reaction, Opponent
    const roundId = await roundWithOpenWindow(caster, [holder]);

    const { error: castError } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();
    await agePollRound(roundId, PAST_GRACE);

    expect((await vote(caster, roundId)).data).toBe(true);
    expect(await advanceRound(caster.client, roundId, "reactionWindowChanged")).toEqual({
      outcome: "noop",
      reason: "layer_incomplete",
    });
    expect(await roundStatus(roundId)).toBe("closed");

    const { data: die } = await admin
      .from("spell_casts")
      .select("id")
      .eq("round_id", roundId)
      .eq("effect_kind", "dice_modifier")
      .single();
    const { error: resolveError } = await caster.client.rpc("resolve_pending_spell_die_in_app", {
      p_cast_id: (die as { id: string }).id,
    });
    expect(resolveError).toBeNull();

    const outcome = await advanceRound(caster.client, roundId, "pendingDieResolved");
    expect(outcome.outcome).toBe("brewer");
    expect(await roundStatus(roundId)).toBe("resolved");
  });
});
