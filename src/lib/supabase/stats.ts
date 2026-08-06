import type { SupabaseClient } from "@supabase/supabase-js";

export type StatsWindow = "all_time" | "last_30_days";

type LeaderboardPlayer = {
  playerId: string;
  displayName: string | null;
  email: string;
};

export type CupsMadeEntry = LeaderboardPlayer & { cupsMade: number };
export type RoundsLostEntry = LeaderboardPlayer & { roundsLost: number };
export type LossPercentageEntry = LeaderboardPlayer & {
  roundsPlayed: number;
  roundsLost: number;
  lossPercentage: number;
};
export type ModifierPeakEntry = LeaderboardPlayer & { peakModifier: number };

export type RoomHistoryEntry = {
  roomId: string;
  date: string;
  resolvedRoundCount: number;
};

export type RoomRoundEntry = {
  roundId: string;
  resolvedAt: string;
  cupsMade: number;
  starterId: string;
  starterDisplayName: string | null;
  starterEmail: string;
  brewerId: string;
  brewerDisplayName: string | null;
  brewerEmail: string;
};

export type RoomAdjustmentEntry = {
  adjustmentId: string;
  createdAt: string;
  delta: number;
  reason: string;
  actorId: string;
  actorDisplayName: string | null;
  actorEmail: string;
  targetId: string;
  targetDisplayName: string | null;
  targetEmail: string;
};

/**
 * Reads the stats_cups_made_{all_time,last_30_days} view
 * (supabase/migrations/0006_stats_leaderboards.sql) — total cups_made
 * across a player's resolved rounds as brewer, most first.
 */
export async function getCupsMadeLeaderboard(
  supabase: SupabaseClient,
  window: StatsWindow,
): Promise<CupsMadeEntry[]> {
  const { data, error } = await supabase
    .from(window === "all_time" ? "stats_cups_made_all_time" : "stats_cups_made_last_30_days")
    .select("player_id, display_name, email, cups_made")
    .order("cups_made", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    playerId: row.player_id as string,
    displayName: row.display_name as string | null,
    email: row.email as string,
    cupsMade: row.cups_made as number,
  }));
}

/**
 * Reads the stats_rounds_lost_{all_time,last_30_days} view — how many
 * resolved rounds each player who has played at least one lost (was
 * brewer on), fewest first ("luckiest").
 */
export async function getRoundsLostLeaderboard(
  supabase: SupabaseClient,
  window: StatsWindow,
): Promise<RoundsLostEntry[]> {
  const { data, error } = await supabase
    .from(window === "all_time" ? "stats_rounds_lost_all_time" : "stats_rounds_lost_last_30_days")
    .select("player_id, display_name, email, rounds_lost")
    .order("rounds_lost", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    playerId: row.player_id as string,
    displayName: row.display_name as string | null,
    email: row.email as string,
    roundsLost: row.rounds_lost as number,
  }));
}

/**
 * Reads the stats_loss_percentage_{all_time,last_30_days} view —
 * rounds_lost / rounds_played as a percentage, lowest (best) first.
 */
export async function getLossPercentageLeaderboard(
  supabase: SupabaseClient,
  window: StatsWindow,
): Promise<LossPercentageEntry[]> {
  const { data, error } = await supabase
    .from(
      window === "all_time" ? "stats_loss_percentage_all_time" : "stats_loss_percentage_last_30_days",
    )
    .select("player_id, display_name, email, rounds_played, rounds_lost, loss_percentage")
    .order("loss_percentage", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    playerId: row.player_id as string,
    displayName: row.display_name as string | null,
    email: row.email as string,
    roundsPlayed: row.rounds_played as number,
    roundsLost: row.rounds_lost as number,
    lossPercentage: Number(row.loss_percentage),
  }));
}

/**
 * Reads the stats_modifier_peak_{all_time,last_30_days} view — the
 * highest running modifier (sum of cups_made across a brewer's resolved
 * rounds within one room) any player has ever reached, highest first.
 */
export async function getModifierPeakLeaderboard(
  supabase: SupabaseClient,
  window: StatsWindow,
): Promise<ModifierPeakEntry[]> {
  const { data, error } = await supabase
    .from(window === "all_time" ? "stats_modifier_peak_all_time" : "stats_modifier_peak_last_30_days")
    .select("player_id, display_name, email, peak_modifier")
    .order("peak_modifier", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    playerId: row.player_id as string,
    displayName: row.display_name as string | null,
    email: row.email as string,
    peakModifier: row.peak_modifier as number,
  }));
}

/**
 * Reads the stats_room_history view — every room (day), newest first, with
 * how many resolved rounds it had, for the history drill-down's day list.
 */
export async function getRoomHistory(supabase: SupabaseClient): Promise<RoomHistoryEntry[]> {
  const { data, error } = await supabase
    .from("stats_room_history")
    .select("room_id, date, resolved_round_count")
    .order("date", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    roomId: row.room_id as string,
    date: row.date as string,
    resolvedRoundCount: row.resolved_round_count as number,
  }));
}

/**
 * Reads the stats_room_rounds view filtered to one room — that day's
 * resolved rounds (starter, brewer, cups_made), newest first.
 */
export async function getRoomRounds(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomRoundEntry[]> {
  const { data, error } = await supabase
    .from("stats_room_rounds")
    .select(
      "round_id, resolved_at, cups_made, starter_id, starter_display_name, starter_email, brewer_id, brewer_display_name, brewer_email",
    )
    .eq("room_id", roomId)
    .order("resolved_at", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    roundId: row.round_id as string,
    resolvedAt: row.resolved_at as string,
    cupsMade: row.cups_made as number,
    starterId: row.starter_id as string,
    starterDisplayName: row.starter_display_name as string | null,
    starterEmail: row.starter_email as string,
    brewerId: row.brewer_id as string,
    brewerDisplayName: row.brewer_display_name as string | null,
    brewerEmail: row.brewer_email as string,
  }));
}

/**
 * Reads the stats_room_adjustments view filtered to one room — that day's
 * logged modifier adjustments (actor, target, delta, reason), newest first
 * (supabase/migrations/0053_stats_modifier_adjustments.sql).
 */
export async function getRoomAdjustments(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomAdjustmentEntry[]> {
  const { data, error } = await supabase
    .from("stats_room_adjustments")
    .select(
      "adjustment_id, created_at, delta, reason, actor_id, actor_display_name, actor_email, target_id, target_display_name, target_email",
    )
    .eq("room_id", roomId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    adjustmentId: row.adjustment_id as string,
    createdAt: row.created_at as string,
    delta: row.delta as number,
    reason: row.reason as string,
    actorId: row.actor_id as string,
    actorDisplayName: row.actor_display_name as string | null,
    actorEmail: row.actor_email as string,
    targetId: row.target_id as string,
    targetDisplayName: row.target_display_name as string | null,
    targetEmail: row.target_email as string,
  }));
}

/**
 * Looks up avatar_url straight from `players` (not a stats view) for a set
 * of player ids, so the restyled leaderboards/history rows (issue #79) can
 * show avatars the same way the Room tab's roster does, without touching
 * any stats view/query.
 */
export async function getPlayerAvatars(
  supabase: SupabaseClient,
  playerIds: string[],
): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(playerIds)];
  if (uniqueIds.length === 0) return new Map();

  const { data, error } = await supabase.from("players").select("id, avatar_url").in("id", uniqueIds);

  if (error) throw error;

  return new Map((data ?? []).map((row) => [row.id as string, row.avatar_url as string | null]));
}
