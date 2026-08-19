import type { SupabaseClient } from "@supabase/supabase-js";

export type BackfillRollEntry = { playerId: string; value: number };
export type BackfillLayer = BackfillRollEntry[];

/**
 * Calls the get_todays_modifiers RPC (0072_admin_backfill_round.sql):
 * each given player's current modifier in today's room, 0 for anyone with
 * no room_players row yet. Feeds the /admin/backfill wizard's client-side
 * replay of resolveLayer.ts (src/lib/game/resolveLayer.ts) so ties can be
 * previewed live, layer by layer, as the admin types in each roll.
 */
export async function getTodaysModifiers(
  supabase: SupabaseClient,
  playerIds: string[],
): Promise<Record<string, number>> {
  if (playerIds.length === 0) return {};

  const { data, error } = await supabase.rpc("get_todays_modifiers", { p_player_ids: playerIds });
  if (error) throw error;

  const rows = (data ?? []) as { player_id: string; modifier: number }[];
  return Object.fromEntries(rows.map((row) => [row.player_id, row.modifier]));
}

/**
 * Calls the admin_backfill_round RPC (0072_admin_backfill_round.sql, issue
 * #274): bulk-records and fully resolves an entire same-day round that
 * nobody logged the app for, from the admin's own entered figures. `layers`
 * is every layer of rolls the admin entered, in order — layer 0 first,
 * each subsequent layer already reduced to whichever subset tied per
 * resolveLayer.ts, exactly matching what the RPC itself will recompute and
 * verify against. Throws with error.code one of RFB33–RFB40 on a rejected
 * submission (see the RPC's own comment for what each means).
 */
export async function adminBackfillRound(
  supabase: SupabaseClient,
  participantIds: string[],
  layers: BackfillLayer[],
): Promise<string> {
  const { data, error } = await supabase.rpc("admin_backfill_round", {
    p_participant_ids: participantIds,
    p_layers: layers.map((layer) => layer.map((entry) => ({ player_id: entry.playerId, value: entry.value }))),
  });
  if (error) throw error;
  return data as string;
}
