import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrapJoinedPlayer } from "./playerRow";

export type RateableRound = {
  roundId: string;
  brewerDisplayName: string | null;
  brewerEmail: string;
  resolvedAt: string;
  /** The caller's own committed score for this round, or null if not yet rated. */
  myScore: number | null;
};

/**
 * The single round (if any) the caller can rate right now (issue #211, part
 * of #208) — drives the rating tab's three states (hidden / pending-dot /
 * already-rated) in place of the prototype's manual state buttons. Mirrors
 * submit_brew_rating's (0058) own eligibility rules rather than calling a
 * dedicated RPC, since every table involved (rounds, round_participants,
 * brew_ratings) is already readable by the caller under existing RLS:
 *
 *   1. Find the caller's most-recent resolved round as a non-brewer
 *      participant — "most recent round only", no backlog (RFB26's rule).
 *   2. If a newer round in that round's room has since resolved, the Rating
 *      Window has closed (RFB27's rule) — nothing to rate, return null.
 *   3. Otherwise it's rateable — look up the caller's own existing rating
 *      (brew_ratings' RLS only ever returns the caller's own row) to decide
 *      pending vs. already-rated.
 *
 * Returns null when there is nothing eligible to rate at all — the tab
 * renders nothing in that case, per the "no dead-end message" decision.
 */
export async function getMyRateableRound(
  supabase: SupabaseClient,
  playerId: string,
): Promise<RateableRound | null> {
  const { data: roundRow, error: roundError } = await supabase
    .from("rounds")
    .select(
      `id, room_id, resolved_at,
       brewer:players!rounds_brewer_id_fkey(display_name, email),
       round_participants!inner(player_id)`,
    )
    .eq("status", "resolved")
    .eq("round_participants.player_id", playerId)
    .neq("brewer_id", playerId)
    .order("resolved_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (roundError) throw roundError;
  if (!roundRow) return null;

  const { count: newerResolvedCount, error: windowError } = await supabase
    .from("rounds")
    .select("id", { count: "exact", head: true })
    .eq("room_id", roundRow.room_id as string)
    .eq("status", "resolved")
    .gt("resolved_at", roundRow.resolved_at as string);

  if (windowError) throw windowError;
  if ((newerResolvedCount ?? 0) > 0) return null;

  const { data: ratingRow, error: ratingError } = await supabase
    .from("brew_ratings")
    .select("score")
    .eq("round_id", roundRow.id as string)
    .eq("rater_player_id", playerId)
    .maybeSingle();

  if (ratingError) throw ratingError;

  const brewer = unwrapJoinedPlayer(roundRow.brewer);

  return {
    roundId: roundRow.id as string,
    brewerDisplayName: brewer?.display_name ?? null,
    brewerEmail: brewer?.email ?? "",
    resolvedAt: roundRow.resolved_at as string,
    myScore: ratingRow ? (ratingRow.score as number) : null,
  };
}

/**
 * Submits or edits (upsert-on-conflict) the caller's own rating of a round's
 * brewer (submit_brew_rating, 0058). Returns the rating row's id.
 */
export async function submitBrewRating(
  supabase: SupabaseClient,
  roundId: string,
  score: number,
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_brew_rating", {
    p_round_id: roundId,
    p_score: score,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Withdraws the caller's own rating for a round (withdraw_brew_rating,
 * 0058) — a no-op if none exists.
 */
export async function withdrawBrewRating(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("withdraw_brew_rating", { p_round_id: roundId });
  if (error) throw error;
}
