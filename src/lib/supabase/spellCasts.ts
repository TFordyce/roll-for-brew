import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModifierEffect } from "@/lib/game/modifierBucket";

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

/**
 * One row of get_round_modifier_effects' raw output (0050): every resolved
 * effect touching a round's rolls, labelled with the card and caster that
 * produced it. Wider than ModifierEffect — includes advantage/disadvantage,
 * which don't compose into a modifier value (they shape roll generation in
 * submit_roll instead) but still need a card/caster label for the UI
 * (issue #164's discarded-roll display).
 */
export type ModifierEffectDetail = {
  targetPlayerId: string;
  effectKind:
    | "flat_modifier"
    | "dice_modifier"
    | "modifier_multiplier"
    | "set_modifier"
    | "advantage"
    | "disadvantage";
  effectParams: { delta?: number; multiplier?: number; value?: number; dice?: string };
  resolvedValue: number | null;
  cardName: string;
  casterPlayerId: string;
};

export type DispellableEffect = {
  effectId: string;
  targetPlayerId: string;
  targetDisplayName: string;
  cardName: string;
  tier: "common" | "rare" | "epic";
};

/**
 * A dice_modifier spell cast still awaiting its value (issue #252) — the
 * caller's own outstanding roll from a card like Six Sugars/Cold Tea/Slipped
 * Spoon, cast but not yet resolved by resolvePendingSpellDieInApp/Manual.
 * `dice` is the card's raw spec (e.g. "1d6"), used to size the roll picker.
 */
export type PendingSpellDie = {
  castId: string;
  cardName: string;
  dice: string;
};

/**
 * Calls the cast_spell_card RPC (supabase/migrations/0019_spell_casts_pre_roll.sql,
 * grew chosenPlayerIds/declaredNumber in 0033 for CHOSEN_PLAYERS/Inscribed
 * Saucer): casts the caller's currently-held Action card during a round's
 * declare-in window. targetPlayerId is omitted (or null) to arm an OPPONENT/
 * PLAYER card before the participant roster is final — set_spell_cast_target
 * fills it in later. chosenPlayerIds is required for a CHOSEN_PLAYERS card
 * (Calami-Tea) — up to the card's max_targets, validated against the round's
 * roster immediately (no deferral, unlike OPPONENT/PLAYER). declaredNumber is
 * required for a declared_number_tea_maker card (Inscribed Saucer), 1-20.
 * TABLE/WILD cards need neither. invokedCardName is required for Genie in the
 * Teapot (#316, migration 0093): the non-Epic Action card it names, whose sole
 * edition instance must be in_deck; the named instance is never moved. Returns
 * the new cast's id.
 */
export async function castSpellCard(
  supabase: SupabaseClient,
  roundId: string,
  options: {
    targetPlayerId?: string;
    chosenPlayerIds?: string[];
    declaredNumber?: number;
    /** Genie in the Teapot (#316): the non-Epic Action card it names. */
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

type RawModifierEffectRow = {
  target_player_id: string;
  effect_kind:
    | "flat_modifier"
    | "dice_modifier"
    | "modifier_multiplier"
    | "set_modifier"
    | "advantage"
    | "disadvantage";
  effect_params: { delta?: number; multiplier?: number; value?: number; dice?: string };
  resolved_value: number | null;
  card_name: string;
  caster_player_id: string;
};

/**
 * Calls the get_round_modifier_effects RPC (0050 widened it to also return
 * card_name/caster_player_id, and to include advantage/disadvantage rows —
 * see getRoundModifierEffectDetails below for the version that surfaces
 * those). Shared by both this function and getRoundModifierEffectDetails so
 * the RPC is only called through one place.
 */
async function fetchRoundModifierEffectRows(
  supabase: SupabaseClient,
  roundId: string,
): Promise<RawModifierEffectRow[]> {
  const { data, error } = await supabase.rpc("get_round_modifier_effects", { p_round_id: roundId });
  if (error) throw error;
  return (data ?? []) as RawModifierEffectRow[];
}

/**
 * Every resolved (non-pending) modifier-bucket effect active on this round,
 * grouped by target player — the input to composeModifier
 * (src/lib/game/modifierBucket.ts) for shaping each LayerEntry.modifier
 * before resolveLayer runs. Excludes advantage/disadvantage, which shape
 * roll generation (submit_roll) instead of composing into a modifier value
 * — toModifierEffect below drops them via its default case, so this stays
 * unaffected by 0050 widening the underlying RPC to include them.
 */
export async function getRoundModifierEffects(
  supabase: SupabaseClient,
  roundId: string,
): Promise<Map<string, ModifierEffect[]>> {
  const rows = await fetchRoundModifierEffectRows(supabase, roundId);

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
 * Calls the get_round_modifier_effects RPC (0050, issue #165): every
 * resolved effect touching this round's rolls, with the card and caster
 * that produced it — including advantage/disadvantage, which
 * getRoundModifierEffects above excludes. Feeds the RollCalculation UI
 * rework (issue #167) that labels each effect by its source card.
 */
export async function getRoundModifierEffectDetails(
  supabase: SupabaseClient,
  roundId: string,
): Promise<ModifierEffectDetail[]> {
  const rows = await fetchRoundModifierEffectRows(supabase, roundId);

  return rows.map((row) => ({
    targetPlayerId: row.target_player_id,
    effectKind: row.effect_kind,
    effectParams: row.effect_params,
    resolvedValue: row.resolved_value,
    cardName: row.card_name,
    casterPlayerId: row.caster_player_id,
  }));
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

/**
 * Calls the get_room_active_effects RPC: every currently-active persistent
 * effect (spell_active_effects, 0020) in the room, for the roster's
 * stackable effect badge (red for negative/gold for positive, issue #69).
 * Visible to any room member — badges aren't a per-player secret the way a
 * held card's identity is.
 */
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

/**
 * Calls the get_dispellable_active_effects RPC: the active effects the
 * caller's currently-held card (a Lesser-Detox-style dispel card) can end
 * early, scoped to the round's room and to the tiers the held card's text
 * allows. Empty if the caller isn't holding a dispel-kind card.
 */
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

/**
 * Calls the end_active_effect RPC: ends another player's active effect
 * early using the caller's currently-held dispel-kind card (Lesser Detox),
 * consuming that card the same way cast_spell_card does.
 */
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

/**
 * Calls the get_my_pending_spell_dice RPC (0069, issue #252): the caller's
 * own dice_modifier casts for this round still awaiting a value — drives
 * PendingSpellDiePanel.tsx, the same "own outstanding thing to resolve"
 * shape as getMyPendingCasts above (a deferred OPPONENT/PLAYER target)
 * rather than a global lookup, since this must resolve before *this*
 * round's own layer can finalize (get_current_layer_rolls_if_complete's new
 * gate, same migration).
 */
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

/**
 * Calls resolve_pending_spell_die_in_app: the app rolls the die
 * server-side and resolves the cast in one step (issue #252), mirroring
 * submitRoll. Returns the raw rolled value (pre-sign) for display.
 */
export async function resolvePendingSpellDieInApp(
  supabase: SupabaseClient,
  castId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("resolve_pending_spell_die_in_app", { p_cast_id: castId });
  if (error) throw error;
  return data as number;
}

/**
 * Calls resolve_pending_spell_die_manual: resolves the cast with a
 * physically-rolled value the player types in (issue #252), mirroring
 * submitManualRoll. The value is trusted client input, range-checked
 * against the card's own dice spec by resolve_pending_spell_die_manual
 * itself.
 */
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

/**
 * Calls round_layer_zero_reaction_window_exists (0069): whether resolving
 * this round's last pending spell die should re-enter the flow via
 * finalizeReactionWindow (a layer-0 window already exists, open or closed-
 * but-blocked) or resolveCompletedLayerIfAny (no window yet — a pre-roll
 * cast like Cold Tea, where opening one is still this round's next step).
 * See afterPendingSpellDieResolved (src/app/rounds/actions.ts).
 */
export async function hasLayerZeroReactionWindow(
  supabase: SupabaseClient,
  roundId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("round_layer_zero_reaction_window_exists", {
    p_round_id: roundId,
  });
  if (error) throw error;
  return data as boolean;
}

function toModifierEffect(row: RawModifierEffectRow): ModifierEffect | null {
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
