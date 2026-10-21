import type { SupabaseClient } from "@supabase/supabase-js";

export type PendingCast = {
  castId: string;
  cardName: string;
  target: "OPPONENT" | "PLAYER" | "WILD";
};

export type ActiveEffectBadge = {
  effectId: string;
  targetPlayerId: string;
  cardName: string;
  tier: "common" | "rare" | "epic";
  polarity: "positive" | "negative" | null;
  roundsRemaining: number;
};

export type DispellableEffect = {
  effectId: string;
  targetPlayerId: string;
  targetDisplayName: string;
  cardName: string;
  tier: "common" | "rare" | "epic";
};

export type PendingSpellDie = {
  castId: string;
  cardName: string;
  dice: string;
};

export async function castSpellCard(
  supabase: SupabaseClient,
  roundId: string,
  options: {
    targetPlayerId?: string;
    chosenPlayerIds?: string[];
    declaredNumber?: number;
    invokedCardName?: string;
  } = {},
): Promise<string> {
  const { data, error } = await supabase.rpc("cast_spell_card", {
    p_round_id: roundId,
    p_target_player_id: options.targetPlayerId ?? null,
    p_chosen_player_ids: options.chosenPlayerIds ?? null,
    p_declared_number: options.declaredNumber ?? null,
    p_invoked_card_name: options.invokedCardName ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function setSpellCastTarget(
  supabase: SupabaseClient,
  castId: string,
  targetPlayerId: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_spell_cast_target", {
    p_cast_id: castId,
    p_target_player_id: targetPlayerId,
  });
  if (error) throw error;
}

export async function setTeaPartyRevoltTarget(
  supabase: SupabaseClient,
  roundId: string,
  targetPlayerId: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_tea_party_revolt_target", {
    p_round_id: roundId,
    p_target_player_id: targetPlayerId,
  });
  if (error) throw error;
}

export type CompelledCast = {
  castingTime: "A" | "R";
  cardName: string;
  brewmageddonCasterId: string;
};

export async function endActiveEffect(
  supabase: SupabaseClient,
  roundId: string,
  effectId: string,
): Promise<void> {
  const { error } = await supabase.rpc("end_active_effect", {
    p_round_id: roundId,
    p_effect_id: effectId,
  });
  if (error) throw error;
}

export async function resolvePendingSpellDieInApp(
  supabase: SupabaseClient,
  castId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("resolve_pending_spell_die_in_app", { p_cast_id: castId });
  if (error) throw error;
  return data as number;
}

export async function resolvePendingSpellDieManual(
  supabase: SupabaseClient,
  castId: string,
  value: number,
): Promise<void> {
  const { error } = await supabase.rpc("resolve_pending_spell_die_manual", {
    p_cast_id: castId,
    p_value: value,
  });
  if (error) throw error;
}
