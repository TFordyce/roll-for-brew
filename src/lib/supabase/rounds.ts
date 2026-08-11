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

/**
 * Calls the start_round RPC (supabase/migrations/0004_round_lifecycle.sql),
 * which opens a new round and auto-enrolls the caller as its first
 * participant. With no roomId, opens a round in the caller's room for
 * today (unchanged real-gameplay behavior). Passing roomId targets that
 * room directly instead — the only way to start a round in the dateless
 * Test Room (issue #102), which today's-date lookup can never find.
 * Returns the new round's id.
 */
export async function startRound(supabase: SupabaseClient, roomId?: string): Promise<string> {
  const { data, error } = await supabase.rpc("start_round", { p_room_id: roomId ?? null });
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
 * Calls the declare_in_late RPC (supabase/migrations/0068_declare_in_late.sql,
 * issue #246 — the "Late Declare" glossary entry). Declares the caller in
 * for a round that's already closed but hasn't rolled yet; idempotent on
 * repeat calls, same as declareIn. Raises RFB31 (isStaleRoundError) if a
 * roll lands before this actually runs.
 */
export async function declareInLate(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("declare_in_late", { p_round_id: roundId });
  if (error) throw error;
}

/**
 * Calls the round_has_any_rolls RPC (supabase/migrations/0068_declare_in_late.sql)
 * — whether any layer of this round has a roll yet, regardless of whose.
 * Used to gate the "Add me in!" (Late Declare) button: once true, the round
 * is past declare_in_late's window and the button should stop rendering.
 * Needs its own security-definer check rather than a plain rolls count — a
 * player who hasn't declared in yet has no rolls of their own to read under
 * RLS (0005_rolls_and_resolution.sql).
 */
export async function roundHasAnyRolls(supabase: SupabaseClient, roundId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("round_has_any_rolls", { p_round_id: roundId });
  if (error) throw error;
  return data as boolean;
}

/**
 * Calls the withdraw_declaration RPC (supabase/migrations/
 * 0043_withdraw_declaration.sql) — undoes an accidental "I'm in" while the
 * round is still open. The starter can't withdraw this way; their
 * round_participants row represents owning the round, not an optional
 * declaration.
 */
export async function withdrawDeclaration(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("withdraw_declaration", { p_round_id: roundId });
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

/**
 * Same round shape as getActiveRound, but looked up directly by id rather
 * than "the room's active round" — used by stall-timeout enforcement
 * (issue #21), which already has a round id in hand and needs to re-read it
 * regardless of whether it's still active (a round it's about to cancel is,
 * by definition, still 'open' or 'closed' at the moment of the check, but
 * addressing by id rather than room avoids relying on that being true).
 */
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

/**
 * The tied subset rerolling a round's given reroll layer (layer > 0 — layer
 * 0's expected rollers are getRoundParticipants, since round_participants
 * already covers it). Used for the "banner naming the tied players" and
 * "only tied players' devices show an active Roll button" UI (issue #20).
 * Carries avatarUrl so the tie-phase view (issue #81) can render tied
 * players with PlayerTile, matching the roster grid elsewhere.
 */
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
