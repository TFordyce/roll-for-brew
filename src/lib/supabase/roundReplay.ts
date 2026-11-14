import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor, type ApiClient } from "@/lib/api/client";
import { useApiForRound } from "./rounds";


export async function confirmRoundReplay(
  supabase: SupabaseClient,
  roundId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  if (await useApiForRound(supabase, "confirmRoundReplay", roundId)) {
    await api().confirmRoundReplay(roundId);
    return;
  }
  const { error } = await supabase.rpc("confirm_round_replay", { p_round_id: roundId });
  if (error) throw error;
}

export async function declineRoundReplay(
  supabase: SupabaseClient,
  roundId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  if (await useApiForRound(supabase, "declineRoundReplay", roundId)) {
    await api().declineRoundReplay(roundId);
    return;
  }
  const { error } = await supabase.rpc("decline_round_replay", { p_round_id: roundId });
  if (error) throw error;
}

export async function autoDeclineStalledRoundReplays(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("auto_decline_stalled_round_replays");
  if (error) throw error;
  return (data as number | null) ?? 0;
}
