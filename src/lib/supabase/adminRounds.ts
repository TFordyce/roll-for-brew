import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrapJoinedPlayer } from "./playerRow";

export type AdminRoundListing = {
  id: string;
  roomId: string;
  roomDate: string;
  status: "open" | "closed" | "resolved" | "cancelled";
  startedAt: string;
  startedByDisplayName: string | null;
  startedByEmail: string;
  brewerDisplayName: string | null;
  brewerEmail: string | null;
  cupsMade: number | null;
};

export async function listRecentRounds(supabase: SupabaseClient, limit = 50): Promise<AdminRoundListing[]> {
  const { data, error } = await supabase
    .from("rounds")
    .select(
      `id, room_id, status, started_at, cups_made,
       room:rooms(date),
       started_by_player:players!rounds_started_by_fkey(display_name, email),
       brewer:players!rounds_brewer_id_fkey(display_name, email)`,
    )
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => {
    const room = unwrapJoinedPlayer(row.room as { date: string } | { date: string }[] | null);
    const startedBy = unwrapJoinedPlayer(row.started_by_player);
    const brewer = unwrapJoinedPlayer(row.brewer);
    return {
      id: row.id as string,
      roomId: row.room_id as string,
      roomDate: room?.date ?? "",
      status: row.status as AdminRoundListing["status"],
      startedAt: row.started_at as string,
      startedByDisplayName: startedBy?.display_name ?? null,
      startedByEmail: startedBy?.email ?? "",
      brewerDisplayName: brewer?.display_name ?? null,
      brewerEmail: brewer?.email ?? null,
      cupsMade: (row.cups_made as number | null) ?? null,
    };
  });
}

export async function adminDeleteRound(supabase: SupabaseClient, roundId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("admin_delete_round", { p_round_id: roundId, p_reason: reason });
  if (error) throw error;
}
