import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModifierEffect } from "@/lib/game/modifierBucket";

export type PendingCast = {
  castId: string;
  cardName: string;
  target: "OPPONENT" | "PLAYER";
};

/**
 * Calls the cast_spell_card RPC (supabase/migrations/0019_spell_casts_pre_roll.sql):
 * casts the caller's currently-held Action card during a round's declare-in
 * window. p_targetPlayerId is omitted (or null) to arm an OPPONENT/PLAYER
 * card before the participant roster is final — set_spell_cast_target fills
 * it in later. Returns the new cast's id.
 */
export async function castSpellCard(
  supabase: SupabaseClient,
  roundId: string,
  targetPlayerId?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("cast_spell_card", {
    p_round_id: roundId,
    p_target_player_id: targetPlayerId ?? null,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Calls the set_spell_cast_target RPC: fills in the deferred target for a
 * cast that was armed before declare-in closed. Only valid once the round
 * has closed (roster final) and only for the cast's own caster.
 */
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

/**
 * Calls the get_round_modifier_effects RPC: every resolved (non-pending)
 * modifier-bucket effect active on this round, grouped by target player —
 * the input to composeModifier (src/lib/game/modifierBucket.ts) for shaping
 * each LayerEntry.modifier before resolveLayer runs. Excludes
 * advantage/disadvantage, which shape roll generation (submit_roll) instead.
 */
export async function getRoundModifierEffects(
  supabase: SupabaseClient,
  roundId: string,
): Promise<Map<string, ModifierEffect[]>> {
  const { data, error } = await supabase.rpc("get_round_modifier_effects", { p_round_id: roundId });
  if (error) throw error;

  const rows = (data ?? []) as {
    target_player_id: string;
    effect_kind: "flat_modifier" | "dice_modifier" | "modifier_multiplier" | "set_modifier";
    effect_params: { delta?: number; multiplier?: number; value?: number };
    resolved_value: number | null;
  }[];

  const byPlayer = new Map<string, ModifierEffect[]>();

  for (const row of rows) {
    const effect = toModifierEffect(row);
    if (!effect) continue;

    const existing = byPlayer.get(row.target_player_id) ?? [];
    existing.push(effect);
    byPlayer.set(row.target_player_id, existing);
  }

  return byPlayer;
}

/**
 * Calls the get_my_pending_casts RPC: the caller's own casts still awaiting
 * a target for this round (user story 23) — an armed OPPONENT/PLAYER card
 * cast before declare-in closed, once the roster is final and it's time to
 * show the target picker.
 */
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

function toModifierEffect(row: {
  effect_kind: "flat_modifier" | "dice_modifier" | "modifier_multiplier" | "set_modifier";
  effect_params: { delta?: number; multiplier?: number; value?: number };
  resolved_value: number | null;
}): ModifierEffect | null {
  switch (row.effect_kind) {
    case "flat_modifier":
      return { kind: "flat", delta: row.effect_params.delta ?? 0 };
    case "dice_modifier":
      return { kind: "flat", delta: row.resolved_value ?? 0 };
    case "modifier_multiplier":
      return { kind: "multiplier", multiplier: row.effect_params.multiplier ?? 1 };
    case "set_modifier":
      return { kind: "set", value: row.effect_params.value ?? 0 };
    default:
      return null;
  }
}
