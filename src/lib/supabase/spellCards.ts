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
  edition: "4th";
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

/**
 * Calls the record_pending_spell_draw RPC (supabase/migrations/
 * 0036_manual_spell_card_draw.sql): records that a nat-1/nat-20 has fired
 * for the caller this round, without drawing yet — replaces the old
 * immediate drawSpellCard call in maybeRecordPendingSpellDraw
 * (roundActionHelpers.ts) so the player can be offered a choice of how the
 * card gets drawn before it actually happens.
 */
export async function recordPendingSpellDraw(
  supabase: SupabaseClient,
  roundId: string,
  trigger: "nat1" | "nat20",
): Promise<void> {
  const { error } = await supabase.rpc("record_pending_spell_draw", {
    p_round_id: roundId,
    p_trigger: trigger,
  });
  if (error) throw error;
}

/**
 * Calls the get_pending_spell_draw RPC: the caller's own pending trigger
 * for this round, if any — feeds the "how did you draw?" prompt
 * (SpellDrawChoicePanel.tsx).
 */
export async function getPendingSpellDraw(
  supabase: SupabaseClient,
  roundId: string,
): Promise<"nat1" | "nat20" | null> {
  const { data, error } = await supabase.rpc("get_pending_spell_draw", { p_round_id: roundId });
  if (error) throw error;

  const rows = (data ?? []) as { trigger: "nat1" | "nat20" }[];
  return rows[0]?.trigger ?? null;
}

/**
 * Calls the draw_pending_spell_card RPC: resolves the caller's pending
 * trigger with the app's own uniformly-random draw (the "draw in-app"
 * choice), same semantics as drawSpellCard.
 */
export async function drawPendingSpellCard(
  supabase: SupabaseClient,
  roundId: string,
): Promise<{ instanceId: string; needsSwapDecision: boolean } | null> {
  const { data, error } = await supabase.rpc("draw_pending_spell_card", { p_round_id: roundId });
  if (error) throw error;

  const rows = (data ?? []) as { instance_id: string | null; needs_swap_decision: boolean }[];
  const [row] = rows;
  if (!row || row.instance_id === null) return null;

  return { instanceId: row.instance_id, needsSwapDecision: row.needs_swap_decision };
}

/**
 * Calls the draw_pending_spell_card_manual RPC: resolves the caller's
 * pending trigger with the specific card they say they physically drew
 * from the real deck. Throws with error.code === "RFB06" if that card has
 * no currently-in-deck instance (a physical/digital desync) — callers
 * should surface that as a retryable message, not a crash.
 */
export async function drawPendingSpellCardManual(
  supabase: SupabaseClient,
  roundId: string,
  cardId: string,
): Promise<{ instanceId: string; needsSwapDecision: boolean } | null> {
  const { data, error } = await supabase.rpc("draw_pending_spell_card_manual", {
    p_round_id: roundId,
    p_card_id: cardId,
  });
  if (error) throw error;

  const rows = (data ?? []) as { instance_id: string | null; needs_swap_decision: boolean }[];
  const [row] = rows;
  if (!row || row.instance_id === null) return null;

  return { instanceId: row.instance_id, needsSwapDecision: row.needs_swap_decision };
}

/**
 * The full spell card catalog's id/name/tier, for resolving a player's
 * free-text "I drew this IRL" input to a card id (and for the datalist
 * that autocompletes it). Reading the whole catalog isn't a blind-deck
 * violation — spell_cards, unlike spell_deck_instances, is already
 * readable by every authenticated player (0017: names/effects aren't
 * secret, only who holds which physical instance is) — so this is a plain
 * table read, not a new RPC.
 */
export async function getSpellCardCatalog(
  supabase: SupabaseClient,
): Promise<{ cardId: string; name: string; tier: "common" | "rare" | "epic"; edition: "4th" }[]> {
  const { data, error } = await supabase
    .from("spell_cards")
    .select("id, name, tier, edition")
    .order("tier")
    .order("name");
  if (error) throw error;

  return (data ?? []).map((row) => ({
    cardId: row.id as string,
    name: row.name as string,
    tier: row.tier as "common" | "rare" | "epic",
    edition: row.edition as "4th",
  }));
}

export type InDeckSpellCard = {
  cardId: string;
  name: string;
  tier: "common" | "rare" | "epic";
  target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD";
  castingTime: "A" | "R";
  edition: "4th";
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
    edition: "4th";
  }[]).map((row) => ({
    cardId: row.card_id,
    name: row.name,
    tier: row.tier,
    target: row.target,
    castingTime: row.casting_time,
    edition: row.edition,
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
    edition: "4th";
  }[]).map((row) => ({
    instanceId: row.instance_id,
    location: row.location,
    cardName: row.card_name,
    castingTime: row.casting_time,
    target: row.target,
    tier: row.tier,
    effectText: row.effect_text,
    effectKind: row.effect_kind,
    edition: row.edition,
  }));
}

export type SpellCollectionCard = {
  cardId: string;
  name: string;
  castingTime: "A" | "R" | null;
  target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD" | "CHOSEN_PLAYERS" | null;
  tier: "common" | "rare" | "epic";
  effectText: string | null;
  drawCount: number;
};

/**
 * Calls the get_player_spell_collection RPC (supabase/migrations/
 * 0039_player_spell_collection.sql): the full 71+-card catalog left-joined
 * against the given player's own draw counts (issue #133, child of the
 * Spell Collection page spec #130). Takes an explicit playerId, not
 * implicit-self like getMySpellCards, since the same call path serves both
 * "my collection" and viewing someone else's — spell names/effects aren't
 * secret (0017/0032), only which physical instance a player currently holds
 * is. castingTime/target/effectText are null until drawCount > 0; the page
 * derives "discovered" as drawCount > 0 rather than a separate flag.
 */
export async function getPlayerSpellCollection(
  supabase: SupabaseClient,
  playerId: string,
): Promise<SpellCollectionCard[]> {
  const { data, error } = await supabase.rpc("get_player_spell_collection", {
    p_player_id: playerId,
  });
  if (error) throw error;

  return ((data ?? []) as {
    card_id: string;
    name: string;
    casting_time: "A" | "R" | null;
    target: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD" | "CHOSEN_PLAYERS" | null;
    tier: "common" | "rare" | "epic";
    effect_text: string | null;
    draw_count: number;
  }[]).map((row) => ({
    cardId: row.card_id,
    name: row.name,
    castingTime: row.casting_time,
    target: row.target,
    tier: row.tier,
    effectText: row.effect_text,
    drawCount: row.draw_count,
  }));
}
