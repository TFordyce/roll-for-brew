import type { SupabaseClient } from "@supabase/supabase-js";

export type BackfillRollEntry = { playerId: string; value: number };
export type BackfillLayer = BackfillRollEntry[];

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
