import type { SupabaseClient } from "@supabase/supabase-js";

export type LayerRoll = {
  playerId: string;
  value: number;
  modifierSnapshot: number;
};

export type CompletedLayer = {
  layer: number;
  rolls: LayerRoll[];
};

/**
 * Calls the submit_roll RPC (supabase/migrations/0007_reroll_layers.sql):
 * submits the caller's own in-app roll for whichever layer the round is
 * currently on (rounds.current_layer — derived server-side, never a client
 * parameter). The die value is generated server-side, not passed in.
 */
export async function submitRoll(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("submit_roll", { p_round_id: roundId });
  if (error) throw error;
}

/**
 * Calls the get_current_layer_rolls_if_complete RPC. Returns the round's
 * current layer number and every expected roller's roll for it once
 * everyone has rolled, or null if the round is still waiting on someone.
 */
export async function getCurrentLayerRollsIfComplete(
  supabase: SupabaseClient,
  roundId: string,
): Promise<CompletedLayer | null> {
  const { data, error } = await supabase.rpc("get_current_layer_rolls_if_complete", {
    p_round_id: roundId,
  });
  if (error) throw error;

  const rows = (data ?? []) as {
    layer: number;
    player_id: string;
    value: number;
    modifier_snapshot: number;
  }[];
  const [first] = rows;
  if (!first) return null;

  return {
    layer: first.layer,
    rolls: rows.map((row) => ({
      playerId: row.player_id,
      value: row.value,
      modifierSnapshot: row.modifier_snapshot,
    })),
  };
}

/**
 * Calls the advance_round_layer RPC: persists a tie outcome the caller
 * already computed via resolveLayer, moving the round on to a new reroll
 * layer for just the tied subset. Returns the new layer number.
 */
export async function advanceRoundLayer(
  supabase: SupabaseClient,
  roundId: string,
  tiedPlayerIds: string[],
): Promise<number> {
  const { data, error } = await supabase.rpc("advance_round_layer", {
    p_round_id: roundId,
    p_tied_player_ids: tiedPlayerIds,
  });
  if (error) throw error;
  return data as number;
}

/**
 * The caller's own roll for a round's given layer, or null if they haven't
 * rolled it yet. Relies on the "roller can read their own row" RLS policy —
 * this is the "reveal to myself the instant I've personally submitted"
 * behaviour, distinct from seeing anyone else's roll before resolution.
 */
export async function getOwnRoll(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
  layer: number,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("rolls")
    .select("value")
    .eq("round_id", roundId)
    .eq("player_id", playerId)
    .eq("layer", layer)
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
