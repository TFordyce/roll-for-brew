import type { SupabaseClient } from "@supabase/supabase-js";

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

export async function getExpectedLayerRollerIds(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
): Promise<Set<string>> {
  const { data, error } = await supabase.rpc("get_expected_layer_roller_ids", {
    p_round_id: roundId,
    p_layer: layer,
  });
  if (error) throw error;

  const rows = (data ?? []) as { player_id: string }[];
  return new Set(rows.map((row) => row.player_id));
}

export async function isExpectedLayerRoller(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
  layer: number,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_expected_layer_roller", {
    p_round_id: roundId,
    p_player_id: playerId,
    p_layer: layer,
  });
  if (error) throw error;
  return data as boolean;
}

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

export async function resolveStalledPendingSpellDice(supabase: SupabaseClient, roundId: string): Promise<number> {
  const { data, error } = await supabase.rpc("resolve_stalled_pending_spell_dice", { p_round_id: roundId });
  if (error) throw error;
  return data as number;
}

export async function resolveStalledPendingForcedRerollCasts(
  supabase: SupabaseClient,
  roundId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("resolve_stalled_pending_forced_reroll_casts", {
    p_round_id: roundId,
  });
  if (error) throw error;
  return data as number;
}

export async function resolveStalledRevoltPicks(supabase: SupabaseClient, roundId: string): Promise<number> {
  const { data, error } = await supabase.rpc("resolve_stalled_revolt_picks", { p_round_id: roundId });
  if (error) throw error;
  return data as number;
}

export async function cancelRound(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_round", { p_round_id: roundId });
  if (error) throw error;
}

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

export type CompelledCastStep = {
  waitingOn: string[];
  endedAt: string | null;
};

export async function getCompelledCastStep(supabase: SupabaseClient, roundId: string): Promise<CompelledCastStep> {
  const { data, error } = await supabase.rpc("get_compelled_cast_step", { p_round_id: roundId });
  if (error) throw error;
  const row = ((data ?? []) as { waiting_on: string[] | null; ended_at: string | null }[])[0];
  return { waitingOn: row?.waiting_on ?? [], endedAt: row?.ended_at ?? null };
}

export async function getLayerZeroWindowClosedAt(supabase: SupabaseClient, roundId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_layer_zero_window_closed_at", { p_round_id: roundId });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function forfeitStalledCompelledCasts(supabase: SupabaseClient, roundId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("forfeit_stalled_compelled_casts", { p_round_id: roundId });
  if (error) throw error;
  return (data ?? []) as string[];
}
