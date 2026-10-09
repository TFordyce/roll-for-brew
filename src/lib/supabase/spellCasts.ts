import type { SupabaseClient } from "@supabase/supabase-js";
import { type LastDripPreview, type RawLastDripPassedOver, parseLastDripPassedOver } from "@/lib/supabase/rolls";

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

export async function getTeaPartyRevoltPicker(supabase: SupabaseClient, roundId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_tea_party_revolt_picker", { p_round_id: roundId });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function getMyPendingCasts(
  supabase: SupabaseClient,
  roundId: string,
): Promise<PendingCast[]> {
  const { data, error } = await supabase.rpc("get_my_pending_casts", { p_round_id: roundId });
  if (error) throw error;

  return ((data ?? []) as { cast_id: string; card_name: string; target: "OPPONENT" | "PLAYER" }[]).map(
    (row) => ({ castId: row.cast_id, cardName: row.card_name, target: row.target }),
  );
}

export type CompelledCast = {
  castingTime: "A" | "R";
  cardName: string;
  brewmageddonCasterId: string;
};

export async function getMyCompelledCast(supabase: SupabaseClient, roundId: string): Promise<CompelledCast | null> {
  const { data, error } = await supabase.rpc("get_my_compelled_cast", { p_round_id: roundId });
  if (error) throw error;
  const row = ((data ?? []) as { casting_time: "A" | "R"; card_name: string; brewmageddon_caster_id: string }[])[0];
  return row
    ? { castingTime: row.casting_time, cardName: row.card_name, brewmageddonCasterId: row.brewmageddon_caster_id }
    : null;
}

export async function getRoomActiveEffects(
  supabase: SupabaseClient,
  roomId: string,
): Promise<ActiveEffectBadge[]> {
  const { data, error } = await supabase.rpc("get_room_active_effects", { p_room_id: roomId });
  if (error) throw error;

  return ((data ?? []) as {
    effect_id: string;
    target_player_id: string;
    card_name: string;
    tier: "common" | "rare" | "epic";
    polarity: "positive" | "negative" | null;
    rounds_remaining: number;
  }[]).map((row) => ({
    effectId: row.effect_id,
    targetPlayerId: row.target_player_id,
    cardName: row.card_name,
    tier: row.tier,
    polarity: row.polarity,
    roundsRemaining: row.rounds_remaining,
  }));
}

export async function getHeistTargetIds(supabase: SupabaseClient, roundId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("get_heist_targets", { p_round_id: roundId });
  if (error) throw error;
  return (data ?? []) as string[];
}

export async function getLastDripPreview(supabase: SupabaseClient, roundId: string): Promise<LastDripPreview | null> {
  const { data, error } = await supabase.rpc("get_last_drip_preview", { p_round_id: roundId });
  if (error) throw error;
  if (!data) return null;
  const raw = data as {
    target_player_id: string | null;
    reason: LastDripPreview["reason"];
    passed_over: RawLastDripPassedOver[];
  };
  return {
    targetPlayerId: raw.target_player_id,
    reason: raw.reason,
    passedOver: parseLastDripPassedOver(raw.passed_over),
  };
}

export async function getDispellableActiveEffects(
  supabase: SupabaseClient,
  roundId: string,
): Promise<DispellableEffect[]> {
  const { data, error } = await supabase.rpc("get_dispellable_active_effects", {
    p_round_id: roundId,
  });
  if (error) throw error;

  return ((data ?? []) as {
    effect_id: string;
    target_player_id: string;
    target_display_name: string;
    card_name: string;
    tier: "common" | "rare" | "epic";
  }[]).map((row) => ({
    effectId: row.effect_id,
    targetPlayerId: row.target_player_id,
    targetDisplayName: row.target_display_name,
    cardName: row.card_name,
    tier: row.tier,
  }));
}

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

export async function getMyPendingSpellDice(
  supabase: SupabaseClient,
  roundId: string,
): Promise<PendingSpellDie[]> {
  const { data, error } = await supabase.rpc("get_my_pending_spell_dice", { p_round_id: roundId });
  if (error) throw error;

  return ((data ?? []) as { cast_id: string; card_name: string; dice: string }[]).map((row) => ({
    castId: row.cast_id,
    cardName: row.card_name,
    dice: row.dice,
  }));
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
