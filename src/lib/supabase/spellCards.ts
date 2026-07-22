import type { SupabaseClient } from "@supabase/supabase-js";

export type HeldSpellCard = {
  instanceId: string;
  location: "held" | "pending_swap";
  cardName: string;
  castingTime: "A" | "R";
  target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD";
  tier: "common" | "rare" | "epic";
  effectText: string;
  effectKind: string | null;
};

/**
 * Calls the draw_spell_card RPC (supabase/migrations/0018_spell_deck_draw_hold_swap.sql):
 * draws one uniformly-random in-deck instance for the caller after a nat-1
 * or nat-20 (issue #66). Returns null if the deck is momentarily exhausted
 * (every instance held/pending — an explicitly unresolved edge case
 * upstream), otherwise the drawn instance's id and whether it's now parked
 * awaiting a keep-or-swap decision (the caller already held a card).
 */
export async function drawSpellCard(
  supabase: SupabaseClient,
  trigger: "nat1" | "nat20",
): Promise<{ instanceId: string; needsSwapDecision: boolean } | null> {
  const { data, error } = await supabase.rpc("draw_spell_card", { p_trigger: trigger });
  if (error) throw error;

  const rows = (data ?? []) as { instance_id: string | null; needs_swap_decision: boolean }[];
  const [row] = rows;
  if (!row || row.instance_id === null) return null;

  return { instanceId: row.instance_id, needsSwapDecision: row.needs_swap_decision };
}

/**
 * Calls the resolve_card_swap RPC: resolves a pending keep-or-swap decision,
 * keeping either the newly-drawn card or the one already held. The other
 * instance is reshuffled back to in_deck, never removed.
 */
export async function resolveCardSwap(supabase: SupabaseClient, keepNew: boolean): Promise<void> {
  const { error } = await supabase.rpc("resolve_card_swap", { p_keep_new: keepNew });
  if (error) throw error;
}

/**
 * Calls the get_my_spell_cards RPC: the caller's own held (and, mid-swap-
 * decision, pending_swap) card instance(s) joined with the catalog — never
 * anyone else's, and never the deck's remaining contents or count (the
 * deck stays blind, user story 9).
 */
export async function getMySpellCards(supabase: SupabaseClient): Promise<HeldSpellCard[]> {
  const { data, error } = await supabase.rpc("get_my_spell_cards");
  if (error) throw error;

  return ((data ?? []) as {
    instance_id: string;
    location: "held" | "pending_swap";
    card_name: string;
    casting_time: "A" | "R";
    target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD";
    tier: "common" | "rare" | "epic";
    effect_text: string;
    effect_kind: string | null;
  }[]).map((row) => ({
    instanceId: row.instance_id,
    location: row.location,
    cardName: row.card_name,
    castingTime: row.casting_time,
    target: row.target,
    tier: row.tier,
    effectText: row.effect_text,
    effectKind: row.effect_kind,
  }));
}
