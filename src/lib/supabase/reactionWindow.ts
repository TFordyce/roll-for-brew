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
