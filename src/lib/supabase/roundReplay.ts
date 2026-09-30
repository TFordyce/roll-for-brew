import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The client bindings for the Round Replay mechanism — Time for Brew (issue
 * #315, spec #302 §11). The replay's rollback + generation bump live in SQL
 * (_rr_scrap_round, invoked by confirm_round_replay); this module is the thin
 * TS layer above it — reading the pending decision back for the blocking
 * prompt, and the caster's confirm / decline calls. The pending decision
 * itself is recorded by Layer finalization (finalize_layer calls
 * record_pending_round_replay in the same transaction as the resolution).
 */

export type RoomPendingRoundReplay = {
  roundId: string;
  casterId: string;
  createdAt: string;
};

/**
 * Calls get_room_pending_round_replay: the room's outstanding replay decision,
 * if any. The round is 'resolved' while this is pending, so page.tsx can't
 * hang the prompt off getActiveRound — it reads this directly.
 */
export async function getRoomPendingRoundReplay(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomPendingRoundReplay | null> {
  const { data, error } = await supabase.rpc("get_room_pending_round_replay", { p_room_id: roomId });
  if (error) throw error;

  const row = (data ?? [])[0] as
    | { round_id: string; caster_id: string; created_at: string }
    | undefined;
  if (!row) return null;

  return { roundId: row.round_id, casterId: row.caster_id, createdAt: row.created_at };
}

/**
 * Calls confirm_round_replay: the Time for Brew caster scraps the resolved
 * round. _rr_scrap_round backs it out to a freshly-closed generation-1 round
 * and recomputes every affected modifier; the pending row is cleared.
 */
export async function confirmRoundReplay(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("confirm_round_replay", { p_round_id: roundId });
  if (error) throw error;
}

/**
 * Calls decline_round_replay: the caster keeps the resolved round. Idempotent
 * — a double-tap, or a race with the stall auto-decline, is fine.
 */
export async function declineRoundReplay(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("decline_round_replay", { p_round_id: roundId });
  if (error) throw error;
}

/**
 * Calls auto_decline_stalled_round_replays: sweeps pending decisions older
 * than the existing 5-minute closed-round stall window (spec §11: "no new
 * clock"). Returns how many it cleared. Swept lazily from page.tsx render —
 * there is no cron anywhere in this app (issue #21's pattern).
 */
export async function autoDeclineStalledRoundReplays(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("auto_decline_stalled_round_replays");
  if (error) throw error;
  return (data as number | null) ?? 0;
}
