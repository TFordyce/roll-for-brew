import type { SupabaseClient } from "@supabase/supabase-js";

export type HeldSpellCard = {
  instanceId: string;
  location: "held" | "pending_swap";
  cardName: string;
  castingTime: "A" | "R";
  target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD" | "CHOSEN_PLAYERS";
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
  roomId?: string,
): Promise<{ instanceId: string; needsSwapDecision: boolean } | null> {
  const { data, error } = await supabase.rpc("draw_spell_card", {
    p_trigger: trigger,
    p_room_id: roomId ?? null,
  });
  if (error) throw error;

  const rows = (data ?? []) as { instance_id: string | null; needs_swap_decision: boolean }[];
  const [row] = rows;
  if (!row || row.instance_id === null) return null;

  return { instanceId: row.instance_id, needsSwapDecision: row.needs_swap_decision };
}

/**
 * Calls the draw_spell_card_as RPC (supabase/migrations/0034_admin_forced_crit_card.sql):
 * the admin "roll for others" counterpart to drawSpellCard — draws for an
 * explicit target player rather than current_player_id()'s Acting As
 * resolution, and optionally forces a specific catalog card (cardId) instead
 * of a random in-deck instance. draw_spell_card_as itself re-checks the
 * caller is an admin acting on the Test Room regardless of what's passed.
 */
export async function drawSpellCardAs(
  supabase: SupabaseClient,
  trigger: "nat1" | "nat20",
  roomId: string,
  playerId: string,
  cardId?: string,
): Promise<{ instanceId: string; needsSwapDecision: boolean } | null> {
  const { data, error } = await supabase.rpc("draw_spell_card_as", {
    p_trigger: trigger,
    p_room_id: roomId,
    p_player_id: playerId,
    p_card_id: cardId ?? null,
  });
  if (error) throw error;

  const rows = (data ?? []) as { instance_id: string | null; needs_swap_decision: boolean }[];
  const [row] = rows;
  if (!row || row.instance_id === null) return null;

  return { instanceId: row.instance_id, needsSwapDecision: row.needs_swap_decision };
}

export type InDeckSpellCard = {
  cardId: string;
  name: string;
  tier: "common" | "rare" | "epic";
  target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD";
  castingTime: "A" | "R";
};

/**
 * Calls the get_in_deck_spell_cards RPC: every catalog card currently
 * drawable in the given room's deck — an admin/Test-Room-only exception to
 * the deck otherwise never disclosing its contents (user story 9), used to
 * populate the "force this card" picker in RollForOthers.tsx.
 */
export async function getInDeckSpellCards(supabase: SupabaseClient, roomId: string): Promise<InDeckSpellCard[]> {
  const { data, error } = await supabase.rpc("get_in_deck_spell_cards", { p_room_id: roomId });
  if (error) throw error;

  return ((data ?? []) as {
    card_id: string;
    name: string;
    tier: "common" | "rare" | "epic";
    target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD";
    casting_time: "A" | "R";
  }[]).map((row) => ({
    cardId: row.card_id,
    name: row.name,
    tier: row.tier,
    target: row.target,
    castingTime: row.casting_time,
  }));
}

/**
 * Calls the resolve_card_swap RPC: resolves a pending keep-or-swap decision,
 * keeping either the newly-drawn card or the one already held. The other
 * instance is reshuffled back to in_deck, never removed.
 */
export async function resolveCardSwap(
  supabase: SupabaseClient,
  keepNew: boolean,
  roomId?: string,
): Promise<void> {
  const { error } = await supabase.rpc("resolve_card_swap", {
    p_keep_new: keepNew,
    p_room_id: roomId ?? null,
  });
  if (error) throw error;
}

/**
 * Calls the get_my_spell_cards RPC: the caller's own held (and, mid-swap-
 * decision, pending_swap) card instance(s) joined with the catalog — never
 * anyone else's, and never the deck's remaining contents or count (the
 * deck stays blind, user story 9).
 */
export async function getMySpellCards(supabase: SupabaseClient, roomId?: string): Promise<HeldSpellCard[]> {
  const { data, error } = await supabase.rpc("get_my_spell_cards", { p_room_id: roomId ?? null });
  if (error) throw error;

  return ((data ?? []) as {
    instance_id: string;
    location: "held" | "pending_swap";
    card_name: string;
    casting_time: "A" | "R";
    target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD" | "CHOSEN_PLAYERS";
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
