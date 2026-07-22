import type { SupabaseClient } from "@supabase/supabase-js";

export type LayerZeroRoll = {
  playerId: string;
  value: number;
  modifierSnapshot: number;
};

/**
 * Calls the submit_roll RPC (supabase/migrations/0005_rolls_and_resolution.sql):
 * submits the caller's own in-app layer-0 roll for a closed round. The die
 * value is generated server-side, not passed in.
 */
export async function submitRoll(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("submit_roll", { p_round_id: roundId });
  if (error) throw error;
}

/**
 * Calls the submit_manual_roll RPC (supabase/migrations/
 * 0006_player_settings_and_manual_rolls.sql): submits the caller's own
 * manually-entered layer-0 roll for a closed round. The value is
 * client-supplied and trusted with no verification beyond the 1-20 range.
 */
export async function submitManualRoll(
  supabase: SupabaseClient,
  roundId: string,
  value: number,
): Promise<void> {
  const { error } = await supabase.rpc("submit_manual_roll", {
    p_round_id: roundId,
    p_value: value,
  });
  if (error) throw error;
}

/**
 * Calls the get_layer0_rolls_if_complete RPC. Returns every participant's
 * layer-0 roll once everyone has rolled, or an empty array if the round is
 * still waiting on someone.
 */
export async function getLayerZeroRollsIfComplete(
  supabase: SupabaseClient,
  roundId: string,
): Promise<LayerZeroRoll[]> {
  const { data, error } = await supabase.rpc("get_layer0_rolls_if_complete", {
    p_round_id: roundId,
  });
  if (error) throw error;

  return (data ?? []).map((row: { player_id: string; value: number; modifier_snapshot: number }) => ({
    playerId: row.player_id,
    value: row.value,
    modifierSnapshot: row.modifier_snapshot,
  }));
}

/**
 * The caller's own layer-0 roll for a round, or null if they haven't
 * rolled yet. Relies on the "roller can read their own row" RLS policy —
 * this is the "reveal to myself the instant I've personally submitted"
 * behaviour, distinct from seeing anyone else's roll before resolution.
 */
export async function getOwnRoll(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("rolls")
    .select("value")
    .eq("round_id", roundId)
    .eq("player_id", playerId)
    .eq("layer", 0)
    .maybeSingle();

  if (error) throw error;
  return data ? (data.value as number) : null;
}

/**
 * Calls the resolve_round RPC: applies a single-brewer outcome the caller
 * already computed via resolveLayer (src/lib/game/resolveLayer.ts) —
 * writes rounds.brewer_id/cups_made/status='resolved'/resolved_at and
 * increments the brewer's modifier, atomically.
 */
export async function resolveRound(
  supabase: SupabaseClient,
  roundId: string,
  brewerId: string,
  cupsMade: number,
): Promise<void> {
  const { error } = await supabase.rpc("resolve_round", {
    p_round_id: roundId,
    p_brewer_id: brewerId,
    p_cups_made: cupsMade,
  });
  if (error) throw error;
}
