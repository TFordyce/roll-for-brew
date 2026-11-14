import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor, type ApiClient } from "@/lib/api/client";
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

export async function enterTodaysRoom(
  supabase: SupabaseClient,
  api: () => Pick<ApiClient, "enterTodaysRoom"> = () => apiClientFor(supabase),
): Promise<string> {
  return (await api().enterTodaysRoom()).roomId;
}

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

export async function getAbsentRealPlayers(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RealPlayer[]> {
  const [players, roster] = await Promise.all([getRealPlayers(supabase), getRoomRoster(supabase, roomId)]);
  const presentIds = new Set(roster.map((r) => r.playerId));
  return players.filter((p) => !presentIds.has(p.id));
}

export async function getTestRoomId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from("rooms").select("id").eq("is_test", true).maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}
