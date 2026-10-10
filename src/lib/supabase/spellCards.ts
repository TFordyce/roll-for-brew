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

export async function drawSpellCardAs(
  supabase: SupabaseClient,
  trigger: "nat1" | "nat20",
  roomId: string,
  roundId: string,
  playerId: string,
  cardId?: string,
): Promise<{ instanceId: string; needsSwapDecision: boolean } | null> {
  const { data, error } = await supabase.rpc("draw_spell_card_as", {
    p_trigger: trigger,
    p_room_id: roomId,
    p_round_id: roundId,
    p_player_id: playerId,
    p_card_id: cardId ?? null,
  });
  if (error) throw error;

  const rows = (data ?? []) as { instance_id: string | null; needs_swap_decision: boolean }[];
  const [row] = rows;
  if (!row || row.instance_id === null) return null;

  return { instanceId: row.instance_id, needsSwapDecision: row.needs_swap_decision };
}

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

export type MyPendingSpellDraw = {
  roundId: string;
  trigger: "nat1" | "nat20";
  otherCount: number;
};

export async function getMyPendingSpellDraw(supabase: SupabaseClient): Promise<MyPendingSpellDraw | null> {
  const { data, error } = await supabase.rpc("get_my_pending_spell_draw");
  if (error) throw error;

  const rows = (data ?? []) as { round_id: string; trigger: "nat1" | "nat20"; other_count: number }[];
  const [row] = rows;
  if (!row) return null;

  return { roundId: row.round_id, trigger: row.trigger, otherCount: row.other_count };
}

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

export async function resolveCardSwap(
  supabase: SupabaseClient,
  keepNew: boolean,
  roomId?: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("resolve_card_swap", {
    p_keep_new: keepNew,
    p_room_id: roomId ?? null,
  });
  if (error) throw error;

  return (data as string | null) ?? null;
}

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
  myRating: number | null;
  isCastEligible: boolean;
};

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
    my_rating: number | null;
    is_cast_eligible: boolean;
  }[]).map((row) => ({
    cardId: row.card_id,
    name: row.name,
    castingTime: row.casting_time,
    target: row.target,
    tier: row.tier,
    effectText: row.effect_text,
    drawCount: row.draw_count,
    myRating: row.my_rating,
    isCastEligible: row.is_cast_eligible,
  }));
}
