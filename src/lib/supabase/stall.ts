import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompletedLayer } from "@/lib/supabase/rolls";

/**
 * When a round's given reroll layer (layer > 0) became current
 * (round_layer_participants.entered_at, migrations/0009) — the layer-N
 * stall clock's start time. Layer 0's equivalent is rounds.closed_at.
 * Returns null if the layer has no participants (shouldn't happen for a
 * layer that's actually current, but guards a bad call cleanly).
 */
export async function getLayerEnteredAt(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("round_layer_participants")
    .select("entered_at")
    .eq("round_id", roundId)
    .eq("layer", layer)
    .order("entered_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? (data.entered_at as string) : null;
}

/**
 * The ids of players who've already rolled the round's current layer —
 * values withheld (rolls stay hidden until reveal per rolls' own RLS
 * policy). Calls the get_current_layer_roller_ids RPC
 * (supabase/migrations/0009_stall_timeout.sql), which grants this to any
 * authenticated caller (not just expected rollers of the current layer) so
 * a spectator's device can drive stall-timeout enforcement too.
 */
export async function getCurrentLayerRollerIds(
  supabase: SupabaseClient,
  roundId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase.rpc("get_current_layer_roller_ids", {
    p_round_id: roundId,
  });
  if (error) throw error;

  const rows = (data ?? []) as { player_id: string }[];
  return new Set(rows.map((row) => row.player_id));
}

/**
 * Calls the get_completed_layer_rolls_for_stall_resolution RPC: the same
 * shape as getCurrentLayerRollsIfComplete, but callable by any authenticated
 * user, not just an expected roller of the current layer — see the RPC's
 * own comment (supabase/migrations/0009_stall_timeout.sql) for why that's
 * safe here specifically. Used only by stall-timeout enforcement, right
 * after it's excluded the layer's stalled non-rollers and the layer is
 * therefore now complete.
 */
export async function getCompletedLayerRollsForStallResolution(
  supabase: SupabaseClient,
  roundId: string,
): Promise<CompletedLayer | null> {
  const { data, error } = await supabase.rpc("get_completed_layer_rolls_for_stall_resolution", {
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
 * Calls the cancel_round RPC: cancels a stalled round (issue #21). A no-op
 * if the round has already left 'open'/'closed' by the time this runs.
 */
export async function cancelRound(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_round", { p_round_id: roundId });
  if (error) throw error;
}

/**
 * Calls the exclude_round_participant RPC: marks a stalled participant
 * excluded from a round's given layer (issue #21), so they stop being
 * waited on without their row being deleted.
 */
export async function excludeRoundParticipant(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
  layer: number,
): Promise<void> {
  const { error } = await supabase.rpc("exclude_round_participant", {
    p_round_id: roundId,
    p_player_id: playerId,
    p_layer: layer,
  });
  if (error) throw error;
}
