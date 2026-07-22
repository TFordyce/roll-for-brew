import type { SupabaseClient } from "@supabase/supabase-js";

export type RosterEntry = {
  playerId: string;
  displayName: string | null;
  email: string;
  modifier: number;
};

/**
 * Calls the enter_todays_room RPC (supabase/migrations/0003_rooms_and_room_players.sql),
 * which idempotently creates/finds today's room (Europe/London) and the
 * caller's room_players row within it, and returns the room's id.
 */
export async function enterTodaysRoom(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc("enter_todays_room");
  if (error) throw error;
  return data as string;
}

/**
 * The room's roster: every player present today, ordered by modifier
 * descending, for the Room tab.
 */
export async function getRoomRoster(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RosterEntry[]> {
  const { data, error } = await supabase
    .from("room_players")
    .select("player_id, modifier, players(display_name, email)")
    .eq("room_id", roomId)
    .order("modifier", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const player = Array.isArray(row.players) ? row.players[0] : row.players;
    return {
      playerId: row.player_id as string,
      displayName: player?.display_name ?? null,
      email: player?.email ?? "",
      modifier: row.modifier as number,
    };
  });
}
