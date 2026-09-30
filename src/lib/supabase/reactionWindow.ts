import type { SupabaseClient } from "@supabase/supabase-js";
import { SKIP_VOTE_GRACE_MS, type SkipVoteState } from "@/lib/game/skipVote";

export type OpenReactionWindow = {
  windowId: string;
  layer: number;
  pollRound: number;
  eligible: boolean;
  alreadyPassed: boolean;
};

export type ReactionStackEntry = {
  castId: string;
  cardName: string;
  casterId: string;
  casterName: string;
  targetStamp: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD";
  negated: boolean;
  parentCastId: string | null;
  seq: number;
};

/**
 * Calls get_open_reaction_window: the round's currently-open reaction window
 * (if any), plus whether the caller is presently eligible to act on it and
 * whether they've already passed this poll round — the state the ribbon
 * banner (ReactionBanner.tsx) renders from.
 */
export async function getOpenReactionWindow(
  supabase: SupabaseClient,
  roundId: string,
): Promise<OpenReactionWindow | null> {
  const { data, error } = await supabase.rpc("get_open_reaction_window", { p_round_id: roundId });
  if (error) throw error;

  const rows = (data ?? []) as {
    window_id: string;
    layer: number;
    poll_round: number;
    eligible: boolean;
    already_passed: boolean;
  }[];
  const [row] = rows;
  if (!row) return null;

  return {
    windowId: row.window_id,
    layer: row.layer,
    pollRound: row.poll_round,
    eligible: row.eligible,
    alreadyPassed: row.already_passed,
  };
}

export type ReactionWindowPendingPlayer = {
  playerId: string;
  displayName: string;
};

/**
 * Calls get_reaction_window_pending_players (0065): every round participant
 * currently eligible for the round's open reaction window (holding a usable
 * Reaction card) who hasn't yet passed or cast this poll round — the ribbon
 * banner (ReactionBanner.tsx) names these players instead of showing a
 * generic "waiting" message. Empty if no window is open.
 */
export async function getReactionWindowPendingPlayers(
  supabase: SupabaseClient,
  roundId: string,
): Promise<ReactionWindowPendingPlayer[]> {
  const { data, error } = await supabase.rpc("get_reaction_window_pending_players", { p_round_id: roundId });
  if (error) throw error;

  return ((data ?? []) as { player_id: string; display_name: string }[]).map((row) => ({
    playerId: row.player_id,
    displayName: row.display_name,
  }));
}

/** Calls get_reaction_stack: the open window's casts so far, oldest first. */
export async function getReactionStack(
  supabase: SupabaseClient,
  roundId: string,
): Promise<ReactionStackEntry[]> {
  const { data, error } = await supabase.rpc("get_reaction_stack", { p_round_id: roundId });
  if (error) throw error;

  return ((data ?? []) as {
    cast_id: string;
    card_name: string;
    caster_id: string;
    caster_name: string;
    target_stamp: ReactionStackEntry["targetStamp"];
    negated: boolean;
    parent_cast_id: string | null;
    seq: number;
  }[]).map((row) => ({
    castId: row.cast_id,
    cardName: row.card_name,
    casterId: row.caster_id,
    casterName: row.caster_name,
    targetStamp: row.target_stamp,
    negated: row.negated,
    parentCastId: row.parent_cast_id,
    seq: row.seq,
  }));
}

/**
 * Calls cast_reaction_spell_card: casts the caller's held Reaction card into
 * the round's open window. targetCastId targets an existing stack entry
 * (CARD-target cards); targetPlayerId targets a player directly. spendAmount
 * is Tea-tally Spent only — the modifier the caster burns, clamped server-side
 * to [0, current effective modifier]; the RPC raises RFB45 if it is omitted
 * for that card and RFB44 if the caster has no modifier to spend. Reopens the
 * poll for every other eligible holder (chaining) as a side effect.
 */
export async function castReactionSpellCard(
  supabase: SupabaseClient,
  roundId: string,
  options: { targetPlayerId?: string; targetCastId?: string; spendAmount?: number } = {},
): Promise<string> {
  const { data, error } = await supabase.rpc("cast_reaction_spell_card", {
    p_round_id: roundId,
    p_target_player_id: options.targetPlayerId ?? null,
    p_target_cast_id: options.targetCastId ?? null,
    p_spend_amount: options.spendAmount ?? null,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Calls pass_reaction_window: records the caller's pass for the window's
 * current poll round. Returns true if that closed the window (every
 * currently-eligible holder has now passed this poll round).
 * passReactionWindowAction doesn't branch on it: it raises
 * reactionWindowChanged either way and finalize_layer's locked read decides.
 */
export async function passReactionWindow(supabase: SupabaseClient, roundId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("pass_reaction_window", { p_round_id: roundId });
  if (error) throw error;
  return data as boolean;
}

/**
 * The Skip vote (issue #411) state of a round's open reaction window, from the
 * caller's side: what the banner renders, plus when the current poll round
 * started (the stall backstop counts from it).
 */
export type ReactionSkipVote = SkipVoteState & { pollRoundStartedAt: string };

/** Calls get_reaction_window_skip_vote (0114). Null when no window is open. */
export async function getReactionSkipVote(
  supabase: SupabaseClient,
  roundId: string,
): Promise<ReactionSkipVote | null> {
  const { data, error } = await supabase.rpc("get_reaction_window_skip_vote", { p_round_id: roundId });
  if (error) throw error;

  const [row] = (data ?? []) as {
    poll_round_started_at: string;
    votes: number;
    threshold: number;
    has_voted: boolean;
    can_vote: boolean;
    waited_on: boolean;
  }[];
  if (!row) return null;

  return {
    pollRoundStartedAt: row.poll_round_started_at,
    votes: row.votes,
    threshold: row.threshold,
    hasVoted: row.has_voted,
    canVote: row.can_vote,
    waitedOn: row.waited_on,
    graceEndsAt: new Date(new Date(row.poll_round_started_at).getTime() + SKIP_VOTE_GRACE_MS),
  };
}

/**
 * Calls vote_skip_reaction_window (0114): the caller's Skip vote for the open
 * window's current poll round. Returns true when this vote reached the
 * threshold, which auto-passed everyone being waited on and closed the window.
 * Raises RFB51 inside the 30-second grace period, RFB52 when the caller can't
 * vote; a repeat vote is a no-op.
 */
export async function voteSkipReactionWindow(supabase: SupabaseClient, roundId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("vote_skip_reaction_window", { p_round_id: roundId });
  if (error) throw error;
  return data as boolean;
}

/**
 * Calls time_out_reaction_window (0114): the stall backstop. Auto-passes
 * everyone still being waited on in the open window and closes it; returns
 * who was auto-passed. stallEnforcement.ts decides the poll round has stalled.
 */
export async function timeOutReactionWindow(supabase: SupabaseClient, roundId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("time_out_reaction_window", { p_round_id: roundId });
  if (error) throw error;
  return (data as string[] | null) ?? [];
}

/**
 * Calls count_eligible_reaction_holders (0064): how many of the round's
 * participants currently hold a usable Reaction card. Zero while a window is
 * still open means nobody can Pass it — the stranded-window shape issue #387
 * is about; stallEnforcement.ts uses this to detect and recover it.
 */
export async function countEligibleReactionHolders(supabase: SupabaseClient, roundId: string): Promise<number> {
  const { data, error } = await supabase.rpc("count_eligible_reaction_holders", { p_round_id: roundId });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * Calls close_reaction_window (0064): marks the window closed. Normally a
 * side effect of open_reaction_window / pass_reaction_window / resolve_card_swap
 * / cast_reaction_spell_card (0104) discovering zero eligible holders — called
 * directly only by stallEnforcement.ts's recovery path for a window some
 * earlier code left stranded.
 */
export async function closeReactionWindow(supabase: SupabaseClient, windowId: string): Promise<void> {
  const { error } = await supabase.rpc("close_reaction_window", { p_window_id: windowId });
  if (error) throw error;
}

// Opening the window, the eager roll-input shim (forced rerolls, flip, swap,
// chosen-pair) and the resolution commit all run inside the round-advancement
// SQL (advance_layer / finalize_layer, ADR 0008) — there are no TS wrappers
// for them (issue #417).
