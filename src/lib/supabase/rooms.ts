import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrapJoinedPlayer } from "./playerRow";
import { getRealPlayers, type RealPlayer } from "./players";

export type RosterEntry = {
  playerId: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  modifier: number;
  isTest: boolean;
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
    .select("player_id, modifier, players(display_name, email, avatar_url, is_test)")
    .eq("room_id", roomId)
    .order("modifier", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const player = unwrapJoinedPlayer(row.players);
    return {
      playerId: row.player_id as string,
      displayName: player?.display_name ?? null,
      email: player?.email ?? "",
      avatarUrl: player?.avatar_url ?? null,
      modifier: row.modifier as number,
      isTest: player?.is_test === true,
    };
  });
}

/**
 * Every real player who has no room_players row in the given room yet —
 * i.e. hasn't opened the app today at all — for the /admin/proxy-roll
 * picker (issue #273's Proxy Roll). Deliberately narrower than "not in
 * getRoomRoster": a player present today but not yet in this round is
 * already reachable via ordinary Late Declare (#246) once they log in
 * themselves, so Proxy Roll only needs to offer the ones who genuinely
 * can't do that.
 */
export async function getAbsentRealPlayers(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RealPlayer[]> {
  const [players, roster] = await Promise.all([getRealPlayers(supabase), getRoomRoster(supabase, roomId)]);
  const presentIds = new Set(roster.map((r) => r.playerId));
  return players.filter((p) => !presentIds.has(p.id));
}

/**
 * The single persistent Test Room's id (issue #101 / ADR 0002) — dateless,
 * so it can't be found via enter_todays_room's date lookup. Null if the
 * seed migration (0024_admin_and_test_room.sql) hasn't run yet.
 */
export async function getTestRoomId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from("rooms").select("id").eq("is_test", true).maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}
