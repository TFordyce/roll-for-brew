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

/** The caller's outstanding Compelled Cast (issue #440): the card Brewmageddon obliges them to play. */
export type CompelledCast = {
  /** "A": cast it now, in the Compelled Cast step. "R": cast it in the Layer-0 Reaction Window. */
  castingTime: "A" | "R";
  cardName: string;
  brewmageddonCasterId: string;
};

/**
 * Calls the get_my_compelled_cast RPC (0117, issue #440): what, if anything,
 * Brewmageddon still obliges the caller to play this round. null once they
 * have cast it, forfeited it, or been released (Brewmageddon countered).
 */
export async function getMyCompelledCast(supabase: SupabaseClient, roundId: string): Promise<CompelledCast | null> {
  const { data, error } = await supabase.rpc("get_my_compelled_cast", { p_round_id: roundId });
  if (error) throw error;
  const row = ((data ?? []) as { casting_time: "A" | "R"; card_name: string; brewmageddon_caster_id: string }[])[0];
  return row
    ? { castingTime: row.casting_time, cardName: row.card_name, brewmageddonCasterId: row.brewmageddon_caster_id }
    : null;
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
 * round's own layer can reach Layer finalization (the completeness hold,
 * _layer_is_complete).
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
