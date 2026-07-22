import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrapJoinedPlayer } from "./playerRow";

export type RoundStatus = "open" | "closed" | "resolved" | "cancelled";

export type ActiveRound = {
  id: string;
  roomId: string;
  startedBy: string;
  status: RoundStatus;
  startedAt: string;
};

export type RoundParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
  declaredAt: string;
};

/**
 * Calls the start_round RPC (supabase/migrations/0004_round_lifecycle.sql),
 * which opens a new round in the caller's room for today and auto-enrolls
 * the caller as its first participant. Returns the new round's id.
 */
export async function startRound(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc("start_round");
  if (error) throw error;
  return data as string;
}

/**
 * Calls the declare_in RPC. Declares the caller in for an open round;
 * idempotent on repeat calls.
 */
export async function declareIn(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("declare_in", { p_round_id: roundId });
  if (error) throw error;
}

/**
 * Calls the close_round RPC. Only succeeds for the round's starter, and
 * only once at least 2 players have declared in.
 */
export async function closeRound(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("close_round", { p_round_id: roundId });
  if (error) throw error;
}

/**
 * The room's currently active round (open or closed, i.e. not yet resolved
 * or cancelled) — there is at most one, enforced by
 * rounds_one_active_per_room. Returns null if the room has no active round.
 */
export async function getActiveRound(
  supabase: SupabaseClient,
  roomId: string,
): Promise<ActiveRound | null> {
  const { data, error } = await supabase
    .from("rounds")
    .select("id, room_id, started_by, status, started_at")
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
  };
}

/**
 * The room a round belongs to — needed after a round has resolved (and so
 * no longer shows up via getActiveRound) to address its room's Realtime
 * broadcast channel.
 */
export async function getRoundRoomId(supabase: SupabaseClient, roundId: string): Promise<string> {
  const { data, error } = await supabase
    .from("rounds")
    .select("room_id")
    .eq("id", roundId)
    .single();

  if (error) throw error;
  return data.room_id as string;
}

/**
 * The round's live declared-in list, for the Room tab's "who's actually
 * playing this round" view — distinct from the day's full roster.
 */
export async function getRoundParticipants(
  supabase: SupabaseClient,
  roundId: string,
): Promise<RoundParticipant[]> {
  const { data, error } = await supabase
    .from("round_participants")
    .select("player_id, declared_at, players(display_name, email)")
    .eq("round_id", roundId)
    .order("declared_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const player = unwrapJoinedPlayer(row.players);
    return {
      playerId: row.player_id as string,
      displayName: player?.display_name ?? null,
      email: player?.email ?? "",
      declaredAt: row.declared_at as string,
    };
  });
}
