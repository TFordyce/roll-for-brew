import type { SupabaseClient } from "@supabase/supabase-js";

export type OpenReactionWindow = {
  windowId: string;
  layer: number;
  pollRound: number;
  eligible: boolean;
  alreadyPassed: boolean;
};

export type ReactionStackEntry = {
  castId: string;
  cardName: string;
  casterId: string;
  casterName: string;
  targetStamp: "SELF" | "OPPONENT" | "PLAYER" | "TABLE" | "CARD" | "WILD";
  negated: boolean;
  parentCastId: string | null;
  seq: number;
};

/**
 * Calls open_reaction_window (supabase/migrations/0020_spell_reaction_window.sql):
 * opens a reaction window for a layer whose rolls are now known. If nobody
 * currently eligible holds a Reaction card, the window closes itself
 * immediately — isClosed tells the caller (layerResolution.ts) whether to
 * finalize the layer right away instead of waiting on reactions.
 */
export async function openReactionWindow(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
): Promise<{ windowId: string; isClosed: boolean }> {
  const { data, error } = await supabase.rpc("open_reaction_window", {
    p_round_id: roundId,
    p_layer: layer,
  });
  if (error) throw error;

  const rows = (data ?? []) as { window_id: string; is_closed: boolean }[];
  const [row] = rows;
  if (!row) throw new Error("open_reaction_window: no row returned");
  return { windowId: row.window_id, isClosed: row.is_closed };
}

/**
 * Calls get_open_reaction_window: the round's currently-open reaction window
 * (if any), plus whether the caller is presently eligible to act on it and
 * whether they've already passed this poll round — the state the ribbon
 * banner (ReactionBanner.tsx) renders from.
 */
export async function getOpenReactionWindow(
  supabase: SupabaseClient,
  roundId: string,
): Promise<OpenReactionWindow | null> {
  const { data, error } = await supabase.rpc("get_open_reaction_window", { p_round_id: roundId });
  if (error) throw error;

  const rows = (data ?? []) as {
    window_id: string;
    layer: number;
    poll_round: number;
    eligible: boolean;
    already_passed: boolean;
  }[];
  const [row] = rows;
  if (!row) return null;

  return {
    windowId: row.window_id,
    layer: row.layer,
    pollRound: row.poll_round,
    eligible: row.eligible,
    alreadyPassed: row.already_passed,
  };
}

/** Calls get_reaction_stack: the open window's casts so far, oldest first. */
export async function getReactionStack(
  supabase: SupabaseClient,
  roundId: string,
): Promise<ReactionStackEntry[]> {
  const { data, error } = await supabase.rpc("get_reaction_stack", { p_round_id: roundId });
  if (error) throw error;

  return ((data ?? []) as {
    cast_id: string;
    card_name: string;
    caster_id: string;
    caster_name: string;
    target_stamp: ReactionStackEntry["targetStamp"];
    negated: boolean;
    parent_cast_id: string | null;
    seq: number;
  }[]).map((row) => ({
    castId: row.cast_id,
    cardName: row.card_name,
    casterId: row.caster_id,
    casterName: row.caster_name,
    targetStamp: row.target_stamp,
    negated: row.negated,
    parentCastId: row.parent_cast_id,
    seq: row.seq,
  }));
}

/**
 * Calls cast_reaction_spell_card: casts the caller's held Reaction card into
 * the round's open window. targetCastId targets an existing stack entry
 * (CARD-target cards); targetPlayerId targets a player directly. Reopens the
 * poll for every other eligible holder (chaining) as a side effect.
 */
export async function castReactionSpellCard(
  supabase: SupabaseClient,
  roundId: string,
  options: { targetPlayerId?: string; targetCastId?: string } = {},
): Promise<string> {
  const { data, error } = await supabase.rpc("cast_reaction_spell_card", {
    p_round_id: roundId,
    p_target_player_id: options.targetPlayerId ?? null,
    p_target_cast_id: options.targetCastId ?? null,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Calls pass_reaction_window: records the caller's pass for the window's
 * current poll round. Returns true if that closed the window (every
 * currently-eligible holder has now passed this poll round) — the caller
 * (passReactionWindowAction) then finalizes the layer.
 */
export async function passReactionWindow(supabase: SupabaseClient, roundId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("pass_reaction_window", { p_round_id: roundId });
  if (error) throw error;
  return data as boolean;
}

/**
 * Calls get_forced_reroll_targets: every player a currently-active
 * forced_reroll reaction (Double Dunk, Milk First?, ...) targets for this
 * round/layer, for layerResolution.ts's finalize step to reroll in place.
 */
export async function getForcedRerollTargets(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
): Promise<string[]> {
  const { data, error } = await supabase.rpc("get_forced_reroll_targets", {
    p_round_id: roundId,
    p_layer: layer,
  });
  if (error) throw error;
  return ((data ?? []) as { target_player_id: string }[]).map((row) => row.target_player_id);
}

/**
 * Calls apply_forced_reroll: replaces a player's already-recorded roll for
 * this round/layer in place and returns the new value.
 */
export async function applyForcedReroll(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
  playerId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("apply_forced_reroll", {
    p_round_id: roundId,
    p_layer: layer,
    p_player_id: playerId,
  });
  if (error) throw error;
  return data as number;
}

/**
 * Calls has_active_cast_kind (0033): whether any un-negated cast of the
 * given effect_kind is active for this round/layer's reaction window — the
 * gate finalizeReactionWindow uses before calling one of the roll-transform
 * apply_* functions below (Dunkin Disaster/Zariel's Fall/Broken Biscuit).
 */
export async function hasActiveCastKind(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
  effectKind: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_active_cast_kind", {
    p_round_id: roundId,
    p_layer: layer,
    p_effect_kind: effectKind,
  });
  if (error) throw error;
  return data as boolean;
}

export type RollChange = { playerId: string; value: number };

/** Calls apply_roll_swap (0033, Dunkin Disaster): swaps the layer's highest and lowest rolls in place. */
export async function applyRollSwap(supabase: SupabaseClient, roundId: string, layer: number): Promise<RollChange[]> {
  const { data, error } = await supabase.rpc("apply_roll_swap", { p_round_id: roundId, p_layer: layer });
  if (error) throw error;
  return ((data ?? []) as { player_id: string; value: number }[]).map((row) => ({ playerId: row.player_id, value: row.value }));
}

/** Calls apply_roll_flip (0033, Zariel's Fall): flips every roll in the layer to 21 minus its value. */
export async function applyRollFlip(supabase: SupabaseClient, roundId: string, layer: number): Promise<RollChange[]> {
  const { data, error } = await supabase.rpc("apply_roll_flip", { p_round_id: roundId, p_layer: layer });
  if (error) throw error;
  return ((data ?? []) as { player_id: string; value: number }[]).map((row) => ({ playerId: row.player_id, value: row.value }));
}

/**
 * Calls apply_lowest_gains_highest_modifier (0033, Broken Biscuit): adds the
 * highest modifier on the table to the layer's lowest roller's roll.
 */
export async function applyLowestGainsHighestModifier(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
): Promise<RollChange[]> {
  const { data, error } = await supabase.rpc("apply_lowest_gains_highest_modifier", {
    p_round_id: roundId,
    p_layer: layer,
  });
  if (error) throw error;
  return ((data ?? []) as { player_id: string; value: number }[]).map((row) => ({ playerId: row.player_id, value: row.value }));
}

export type TeaMakerOverride = {
  mode: "highest_modifier" | "highest_roll" | "chosen";
  noModifierGain: boolean;
  chosenPlayerId: string | null;
  targetPending: boolean;
};

/**
 * Calls get_tea_maker_override (0033): the round's active tea_maker_override
 * cast (Drip Tray/Topsy-Tea/Wild Brew Surge branch 6), if any — consulted by
 * applyLayerOutcome before calling resolveLayer, since these cards decide the
 * brewer by a rule other than "lowest roll+modifier wins".
 */
export async function getTeaMakerOverride(supabase: SupabaseClient, roundId: string): Promise<TeaMakerOverride | null> {
  const { data, error } = await supabase.rpc("get_tea_maker_override", { p_round_id: roundId });
  if (error) throw error;

  const rows = (data ?? []) as {
    mode: "highest_modifier" | "highest_roll" | "chosen";
    no_modifier_gain: boolean;
    chosen_player_id: string | null;
    target_pending: boolean;
  }[];
  const [row] = rows;
  if (!row) return null;

  return {
    mode: row.mode,
    noModifierGain: row.no_modifier_gain,
    chosenPlayerId: row.chosen_player_id,
    targetPending: row.target_pending,
  };
}

/**
 * Calls resolve_declared_number_tea_maker (0033, Inscribed Saucer): checks a
 * just-completed layer's rolls against any live declared number in the
 * round's room and, on a match, consumes it and returns who it names as
 * brewer (null if no match).
 */
export async function resolveDeclaredNumberTeaMaker(
  supabase: SupabaseClient,
  roundId: string,
  layer: number,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("resolve_declared_number_tea_maker", {
    p_round_id: roundId,
    p_layer: layer,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}
