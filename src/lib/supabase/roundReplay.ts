import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor, type ApiClient } from "@/lib/api/client";


export async function confirmRoundReplay(
  supabase: SupabaseClient,
  roundId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  await api().confirmRoundReplay(roundId);
}

export async function declineRoundReplay(
  supabase: SupabaseClient,
  roundId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  await api().declineRoundReplay(roundId);
}

export async function autoDeclineStalledRoundReplays(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("auto_decline_stalled_round_replays");
  if (error) throw error;
  return (data as number | null) ?? 0;
}
