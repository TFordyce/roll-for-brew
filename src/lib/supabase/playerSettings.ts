import type { SupabaseClient } from "@supabase/supabase-js";

export type RollInputMode = "in_app_only" | "manual_only" | "both";

export const ROLL_INPUT_MODES: RollInputMode[] = ["in_app_only", "manual_only", "both"];

const DEFAULT_ROLL_INPUT_MODE: RollInputMode = "in_app_only";

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
