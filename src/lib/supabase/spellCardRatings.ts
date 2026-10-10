import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor, type ApiClient } from "@/lib/api/client";
import { isPortEnabled } from "@/lib/api/portFlags";


export async function rateSpellCard(
  supabase: SupabaseClient,
  cardId: string,
  score: number,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<string> {
  if (await isPortEnabled(supabase, "rateSpellCard")) return (await api().rateSpellCard(cardId, score)).id;
  const { data, error } = await supabase.rpc("rate_spell_card", {
    p_card_id: cardId,
    p_score: score,
  });
  if (error) throw error;
  return data as string;
}

export async function withdrawSpellCardRating(
  supabase: SupabaseClient,
  cardId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  if (await isPortEnabled(supabase, "withdrawSpellCardRating")) {
    await api().withdrawSpellCardRating(cardId);
    return;
  }
  const { error } = await supabase.rpc("withdraw_spell_card_rating", { p_card_id: cardId });
  if (error) throw error;
}
