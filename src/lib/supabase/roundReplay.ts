import type { SupabaseClient } from "@supabase/supabase-js";


export type RoomPendingRoundReplay = {
  roundId: string;
  casterId: string;
  createdAt: string;
};

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

export async function confirmRoundReplay(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("confirm_round_replay", { p_round_id: roundId });
  if (error) throw error;
}

export async function declineRoundReplay(supabase: SupabaseClient, roundId: string): Promise<void> {
  const { error } = await supabase.rpc("decline_round_replay", { p_round_id: roundId });
  if (error) throw error;
}

export async function autoDeclineStalledRoundReplays(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("auto_decline_stalled_round_replays");
  if (error) throw error;
  return (data as number | null) ?? 0;
}
