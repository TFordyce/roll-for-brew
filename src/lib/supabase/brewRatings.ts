import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor, type ApiClient } from "@/lib/api/client";
import { isPortEnabled } from "@/lib/api/portFlags";

export type RateableRound = {
  roundId: string;
  brewerDisplayName: string | null;
  brewerEmail: string;
  resolvedAt: string;
  myScore: number | null;
};

export async function submitBrewRating(
  supabase: SupabaseClient,
  roundId: string,
  score: number,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<string> {
  if (await isPortEnabled(supabase, "submitBrewRating")) return (await api().submitBrewRating(roundId, score)).id;
  const { data, error } = await supabase.rpc("submit_brew_rating", {
    p_round_id: roundId,
    p_score: score,
  });
  if (error) throw error;
  return data as string;
}

export async function withdrawBrewRating(
  supabase: SupabaseClient,
  roundId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  if (await isPortEnabled(supabase, "withdrawBrewRating")) {
    await api().withdrawBrewRating(roundId);
    return;
  }
  const { error } = await supabase.rpc("withdraw_brew_rating", { p_round_id: roundId });
  if (error) throw error;
}
