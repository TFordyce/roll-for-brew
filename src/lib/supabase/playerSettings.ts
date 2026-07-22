import type { SupabaseClient } from "@supabase/supabase-js";

export type RollInputMode = "in_app_only" | "manual_only" | "both";

export const ROLL_INPUT_MODES: RollInputMode[] = ["in_app_only", "manual_only", "both"];

const DEFAULT_ROLL_INPUT_MODE: RollInputMode = "in_app_only";

/**
 * The caller's own roll_input_mode preference (supabase/migrations/
 * 0008_player_settings_and_manual_rolls.sql), defaulting to 'in_app_only'
 * for a player who has never visited Settings and so has no row yet.
 */
export async function getRollInputMode(
  supabase: SupabaseClient,
  playerId: string,
): Promise<RollInputMode> {
  const { data, error } = await supabase
    .from("player_settings")
    .select("roll_input_mode")
    .eq("player_id", playerId)
    .maybeSingle();

  if (error) throw error;
  return (data?.roll_input_mode as RollInputMode | undefined) ?? DEFAULT_ROLL_INPUT_MODE;
}

/**
 * Upserts the caller's roll_input_mode preference. Direct table write (not
 * an RPC) protected by player_settings' own-row RLS policies — there's no
 * cross-player invariant to guard here, unlike the round/roll RPCs.
 */
export async function setRollInputMode(
  supabase: SupabaseClient,
  playerId: string,
  mode: RollInputMode,
): Promise<void> {
  const { error } = await supabase
    .from("player_settings")
    .upsert({ player_id: playerId, roll_input_mode: mode, updated_at: new Date().toISOString() });

  if (error) throw error;
}
