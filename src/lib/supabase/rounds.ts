import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrapJoinedPlayer } from "./playerRow";

export type RoundStatus = "open" | "closed" | "resolved" | "cancelled";

export type ActiveRound = {
  id: string;
  roomId: string;
  startedBy: string;
  status: RoundStatus;
  startedAt: string;
  closedAt: string | null;
  currentLayer: number;
};

export type RoundParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  declaredAt: string;
  excludedAt: string | null;
};

export async function startRound(supabase: SupabaseClient, roomId?: string): Promise<string> {
  const { data, error } = await supabase.rpc("start_round", { p_room_id: roomId ?? null });
  if (error) throw error;
  return data as string;
}

export async function declareIn(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("declare_in", { p_round_id: roundId });
  if (error) throw error;
}

export async function declareInLate(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("declare_in_late", { p_round_id: roundId });
  if (error) throw error;
}

export async function roundHasAnyRolls(supabase: SupabaseClient, roundId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("round_has_any_rolls", { p_round_id: roundId });
  if (error) throw error;
  return data as boolean;
}

export async function withdrawDeclaration(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("withdraw_declaration", { p_round_id: roundId });
  if (error) throw error;
}

export async function closeRound(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("close_round", { p_round_id: roundId });
  if (error) throw error;
}

export async function getActiveRound(
  supabase: SupabaseClient,
  roomId: string,
): Promise<ActiveRound | null> {
  const { data, error } = await supabase
    .from("rounds")
    .select("id, room_id, started_by, status, started_at, closed_at, current_layer")
    .eq("room_id", roomId)
    .in("status", ["open", "closed"])
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id as string,
    roomId: data.room_id as string,
    startedBy: data.started_by as string,
    status: data.status as RoundStatus,
    startedAt: data.started_at as string,
    closedAt: data.closed_at as string | null,
    currentLayer: data.current_layer as number,
  };
}

export async function getRoundById(
  supabase: SupabaseClient,
  roundId: string,
): Promise<ActiveRound | null> {
  const { data, error } = await supabase
    .from("rounds")
    .select("id, room_id, started_by, status, started_at, closed_at, current_layer")
    .eq("id", roundId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id as string,
    roomId: data.room_id as string,
    startedBy: data.started_by as string,
    status: data.status as RoundStatus,
    startedAt: data.started_at as string,
    closedAt: data.closed_at as string | null,
    currentLayer: data.current_layer as number,
  };
}

export async function getRoundRoomId(supabase: SupabaseClient, roundId: string): Promise<string> {
  const { data, error } = await supabase
    .from("rounds")
    .select("room_id")
    .eq("id", roundId)
    .single();

  if (error) throw error;
  return data.room_id as string;
}

export async function getRoundParticipants(
  supabase: SupabaseClient,
  roundId: string,
): Promise<RoundParticipant[]> {
  const { data, error } = await supabase
    .from("round_participants")
    .select("player_id, declared_at, excluded_at, players(display_name, email, avatar_url)")
    .eq("round_id", roundId)
    .order("declared_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const player = unwrapJoinedPlayer(row.players);
    return {
      playerId: row.player_id as string,
      displayName: player?.display_name ?? null,
      email: player?.email ?? "",
      avatarUrl: player?.avatar_url ?? null,
      declaredAt: row.declared_at as string,
      excludedAt: row.excluded_at as string | null,
    };
  });
}

export type RoundLayerParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  excludedAt: string | null;
};

export async function getRoundLayerParticipants(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
): Promise<RoundLayerParticipant[]> {
  const { data, error } = await supabase
    .from("round_layer_participants")
    .select("player_id, excluded_at, players(display_name, email, avatar_url)")
    .eq("round_id", roundId)
    .eq("layer", layer);

  if (error) throw error;

  return (data ?? []).map((row) => {
    const player = unwrapJoinedPlayer(row.players);
    return {
      playerId: row.player_id as string,
      displayName: player?.display_name ?? null,
      email: player?.email ?? "",
      avatarUrl: player?.avatar_url ?? null,
      excludedAt: row.excluded_at as string | null,
    };
  });
}
