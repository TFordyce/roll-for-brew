import type { SupabaseClient } from "@supabase/supabase-js";

export type SpellCardInfo = {
  instanceId: string;
  name: string;
  tier: "common" | "rare" | "epic";
  castingTime: "action" | "reaction";
  target: "self" | "opponent" | "player" | "table" | "card" | "wild";
  effectText: string;
};

export type PendingSpellCardSwap = {
  drawId: string;
  newCard: SpellCardInfo;
  currentCard: SpellCardInfo;
};

export type OwnSpellCardState = {
  held: SpellCardInfo | null;
  pendingSwap: PendingSpellCardSwap | null;
};

/**
 * Calls the get_own_spell_card_state RPC (supabase/migrations/
 * 0020_own_spell_card_state.sql): the caller's own held card, plus any
 * keep-or-swap decision still awaiting a choice, in one call. Returns
 * neither the deck's contents nor its remaining count — the deck stays
 * blind (issue #66).
 */
export async function getOwnSpellCardState(supabase: SupabaseClient): Promise<OwnSpellCardState> {
  const { data, error } = await supabase.rpc("get_own_spell_card_state");
  if (error) throw error;

  const state = (data ?? {}) as { held: SpellCardInfo | null; pendingSwap: PendingSpellCardSwap | null };
  return {
    held: state.held ?? null,
    pendingSwap: state.pendingSwap ?? null,
  };
}

/**
 * Calls the resolve_spell_card_swap RPC (supabase/migrations/
 * 0018_spell_deck_instances_and_draws.sql): resolves a pending keep-or-swap
 * decision from a draw made while already holding a card. The non-kept
 * instance is reshuffled back into the deck (never removed).
 */
export async function resolveSpellCardSwap(
  supabase: SupabaseClient,
  drawId: string,
  keepNew: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("resolve_spell_card_swap", {
    p_draw_id: drawId,
    p_keep_new: keepNew,
  });
  if (error) throw error;
}
