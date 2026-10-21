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

export type CourageToken = {
  effectId: string;
  giverPlayerId: string;
  giverDisplayName: string;
  dice: string;
};

export async function spendCourageToken(supabase: SupabaseClient, roundId: string): Promise<string> {
  const { data, error } = await supabase.rpc("spend_courage_token", { p_round_id: roundId });
  if (error) throw error;
  return data as string;
}

export async function passReactionWindow(supabase: SupabaseClient, roundId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("pass_reaction_window", { p_round_id: roundId });
  if (error) throw error;
  return data as boolean;
}

export type ReactionSkipVote = SkipVoteState & { pollRoundStartedAt: string };

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

export async function voteSkipReactionWindow(supabase: SupabaseClient, roundId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("vote_skip_reaction_window", { p_round_id: roundId });
  if (error) throw error;
  return data as boolean;
}

export async function timeOutReactionWindow(supabase: SupabaseClient, roundId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("time_out_reaction_window", { p_round_id: roundId });
  if (error) throw error;
  return (data as string[] | null) ?? [];
}

export async function countEligibleReactionHolders(supabase: SupabaseClient, roundId: string): Promise<number> {
  const { data, error } = await supabase.rpc("count_eligible_reaction_holders", { p_round_id: roundId });
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function closeReactionWindow(supabase: SupabaseClient, windowId: string): Promise<void> {
  const { error } = await supabase.rpc("close_reaction_window", { p_window_id: windowId });
  if (error) throw error;
}

