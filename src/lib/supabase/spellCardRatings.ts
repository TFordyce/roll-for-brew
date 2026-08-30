import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Thin typed wrappers over the spell-card rating RPCs (issue #300,
 * supabase/migrations/0073_spell_card_ratings.sql) — a player privately
 * rating a catalog spell card they've cast, 1-5 stars, from the card
 * inspector in their own Spell Collection. Mirrors brewRatings.ts's
 * conventions; the collection page preloads the current rating via
 * get_player_spell_collection's my_rating column, so there is no
 * "read my rating" wrapper here.
 */

/**
 * Submits or edits (upsert-on-conflict) the caller's own rating of a spell
 * card (rate_spell_card, 0073). Returns the rating row's id. Throws with
 * error.code "RFB41" (score out of range), "RFB42" (card not found), or
 * "RFB43" (caller has no eligible cast of the card).
 */
export async function rateSpellCard(
  supabase: SupabaseClient,
  cardId: string,
  score: number,
): Promise<string> {
  const { data, error } = await supabase.rpc("rate_spell_card", {
    p_card_id: cardId,
    p_score: score,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Withdraws the caller's own rating for a spell card
 * (withdraw_spell_card_rating, 0073) — a no-op if none exists.
 */
export async function withdrawSpellCardRating(supabase: SupabaseClient, cardId: string): Promise<void> {
  const { error } = await supabase.rpc("withdraw_spell_card_rating", { p_card_id: cardId });
  if (error) throw error;
}
