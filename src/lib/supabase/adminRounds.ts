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

/**
 * Recent rounds across every room, newest first, for the /admin/rounds
 * cleanup tool (issue #189). rounds/rooms are already readable by any
 * authenticated user (0003/0004's select policies), so this is a plain
 * query -- no admin-only list RPC needed, unlike admin_delete_round itself
 * which mutates and so re-checks is_admin server-side regardless of this
 * page's own gate. rounds has two foreign keys into players (started_by,
 * brewer_id), so each embed is disambiguated by its default constraint name
 * (<table>_<column>_fkey), the same way modifier_adjustments' dual-FK embed
 * is resolved (0052 era, src/lib/supabase/modifierAdjustments.ts).
 */
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

/**
 * Calls the admin_delete_round RPC (0055): hard-deletes a single round and
 * everything cascaded off it (rolls, participants, spell casts, ...),
 * logging a snapshot + the given reason to admin_round_deletions first
 * since the round row itself won't exist afterward to attach the reason to.
 * Throws with error.code "RFB16" if the caller isn't an admin, "RFB17" for
 * a blank reason, "RFB18" if the round doesn't exist.
 */
export async function adminDeleteRound(supabase: SupabaseClient, roundId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("admin_delete_round", { p_round_id: roundId, p_reason: reason });
  if (error) throw error;
}
