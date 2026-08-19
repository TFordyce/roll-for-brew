import type { SupabaseClient } from "@supabase/supabase-js";

export type LayerRoll = {
  playerId: string;
  value: number;
  modifierSnapshot: number;
  // Only non-null when advantage/disadvantage applied this roll (0049/0051,
  // issue #164/#167) — the d20 rolled a second time and not kept, shown
  // struck-through next to the kept value.
  discardedValue: number | null;
  // True for a value an admin entered on the player's behalf (issue #273's
  // Proxy Roll) rather than the player submitting it themselves — surfaced
  // as a provenance badge in round history, never hidden from it.
  enteredByAdmin: boolean;
};

export type CompletedLayer = {
  layer: number;
  rolls: LayerRoll[];
};

/**
 * Calls the submit_roll RPC (supabase/migrations/0007_reroll_layers.sql,
 * return type changed to integer in 0019_spell_casts_pre_roll.sql):
 * submits the caller's own in-app roll for whichever layer the round is
 * currently on (rounds.current_layer — derived server-side, never a client
 * parameter). The die value is generated server-side, not passed in.
 * Returns the final kept raw d20 value (after any advantage/disadvantage
 * roll-twice resolution) so the caller can detect a nat-1/nat-20 for the
 * spell-card draw trigger (issue #66) without a second round trip.
 */
export async function submitRoll(supabase: SupabaseClient, roundId: string): Promise<number> {
  const { data, error } = await supabase.rpc("submit_roll", { p_round_id: roundId });
  if (error) throw error;
  return data as number;
}

/**
 * Calls the submit_manual_roll RPC (supabase/migrations/
 * 0008_player_settings_and_manual_rolls.sql): submits the caller's own
 * manually-entered roll for whichever layer the round is currently on
 * (rounds.current_layer — derived server-side, same as submit_roll). The
 * value is client-supplied and trusted with no verification beyond the 1-20
 * range.
 */
export async function submitManualRoll(
  supabase: SupabaseClient,
  roundId: string,
  value: number,
): Promise<void> {
  const { error } = await supabase.rpc("submit_manual_roll", {
    p_round_id: roundId,
    p_value: value,
  });
  if (error) throw error;
}

/**
 * Calls the submit_roll_as RPC (supabase/migrations/0029_admin_roll_as.sql):
 * an admin submitting an in-app roll directly for another Test Room player,
 * without first switching Acting As to become them. Admin-only and
 * Test-Room-only, enforced server-side by the RPC itself.
 */
export async function submitRollAs(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("submit_roll_as", {
    p_round_id: roundId,
    p_player_id: playerId,
  });
  if (error) throw error;
  return data as number;
}

/**
 * Calls the submit_manual_roll_as RPC (supabase/migrations/0029_admin_roll_as.sql):
 * an admin submitting a manually-entered roll directly for another Test Room
 * player, same admin/Test-Room gating as submitRollAs.
 */
export async function submitManualRollAs(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
  value: number,
): Promise<void> {
  const { error } = await supabase.rpc("submit_manual_roll_as", {
    p_round_id: roundId,
    p_player_id: playerId,
    p_value: value,
  });
  if (error) throw error;
}

/**
 * Calls the admin_proxy_roll RPC (supabase/migrations/0071_admin_proxy_roll.sql,
 * issue #273 — the "Proxy Roll" glossary entry): an admin entering a value
 * on behalf of a player who's physically present but hasn't opened the app
 * today, folding them into the round as a full participant. Unlike
 * submitRollAs/submitManualRollAs, this isn't Test-Room-only — it's for a
 * genuinely live real-room round — and it implicitly creates the target's
 * room_players row rather than requiring one to already exist. Raises
 * RFB32 (isStaleRoundError) if the round moves on before this lands.
 */
export async function adminProxyRoll(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
  value: number,
): Promise<void> {
  const { error } = await supabase.rpc("admin_proxy_roll", {
    p_round_id: roundId,
    p_player_id: playerId,
    p_value: value,
  });
  if (error) throw error;
}

/**
 * Calls the get_current_layer_rolls_if_complete RPC. Returns the round's
 * current layer number and every expected roller's roll for it once
 * everyone has rolled, or null if the round is still waiting on someone.
 */
export async function getCurrentLayerRollsIfComplete(
  supabase: SupabaseClient,
  roundId: string,
): Promise<CompletedLayer | null> {
  const { data, error } = await supabase.rpc("get_current_layer_rolls_if_complete", {
    p_round_id: roundId,
  });
  if (error) throw error;

  const rows = (data ?? []) as {
    layer: number;
    player_id: string;
    value: number;
    modifier_snapshot: number;
    discarded_value: number | null;
    entered_by_admin: boolean;
  }[];
  const [first] = rows;
  if (!first) return null;

  return {
    layer: first.layer,
    rolls: rows.map((row) => ({
      playerId: row.player_id,
      value: row.value,
      modifierSnapshot: row.modifier_snapshot,
      discardedValue: row.discarded_value,
      enteredByAdmin: row.entered_by_admin,
    })),
  };
}

/**
 * Calls the get_round_layer_history RPC (supabase/migrations/
 * 0061_round_layer_roll_history.sql, issue #220): every already-revealed
 * layer's rolls for a round, grouped by layer — layer 0 plus any tie-break
 * reroll layers the round has gone through so far. Unlike
 * getCurrentLayerRollsIfComplete, this isn't restricted to the current
 * layer or to that layer's own expected rollers — a pure spectator, or
 * anyone re-reading history after the round has moved on, gets the same
 * answer. Feeds RoundReveal's nested dependent-row rendering for chained
 * ties.
 */
export async function getRoundLayerHistory(supabase: SupabaseClient, roundId: string): Promise<CompletedLayer[]> {
  const { data, error } = await supabase.rpc("get_round_layer_history", { p_round_id: roundId });
  if (error) throw error;

  const rows = (data ?? []) as {
    layer: number;
    player_id: string;
    value: number;
    modifier_snapshot: number;
    discarded_value: number | null;
    entered_by_admin: boolean;
  }[];

  const byLayer = new Map<number, LayerRoll[]>();
  for (const row of rows) {
    const rolls = byLayer.get(row.layer) ?? [];
    rolls.push({
      playerId: row.player_id,
      value: row.value,
      modifierSnapshot: row.modifier_snapshot,
      discardedValue: row.discarded_value,
      enteredByAdmin: row.entered_by_admin,
    });
    byLayer.set(row.layer, rolls);
  }

  return [...byLayer.entries()]
    .sort(([a], [b]) => a - b)
    .map(([layer, rolls]) => ({ layer, rolls }));
}

/**
 * Calls the advance_round_layer RPC: persists a tie outcome the caller
 * already computed via resolveLayer, moving the round on to a new reroll
 * layer for just the tied subset. Returns the new layer number.
 */
export async function advanceRoundLayer(
  supabase: SupabaseClient,
  roundId: string,
  tiedPlayerIds: string[],
): Promise<number> {
  const { data, error } = await supabase.rpc("advance_round_layer", {
    p_round_id: roundId,
    p_tied_player_ids: tiedPlayerIds,
  });
  if (error) throw error;
  return data as number;
}

/**
 * The caller's own roll for a round's given layer, or null if they haven't
 * rolled it yet. Relies on the "roller can read their own row" RLS policy —
 * this is the "reveal to myself the instant I've personally submitted"
 * behaviour, distinct from seeing anyone else's roll before resolution.
 */
export async function getOwnRoll(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
  layer: number,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("rolls")
    .select("value")
    .eq("round_id", roundId)
    .eq("player_id", playerId)
    .eq("layer", layer)
    .maybeSingle();

  if (error) throw error;
  return data ? (data.value as number) : null;
}

/**
 * Calls the resolve_round RPC: applies a single-brewer outcome the caller
 * already computed via resolveLayer (src/lib/game/resolveLayer.ts) —
 * writes rounds.brewer_id/cups_made/status='resolved'/resolved_at and, unless
 * noModifierGain is set (Drip Tray's "they gain no modifier from this
 * tea-making", 0033), increments the brewer's modifier, atomically.
 */
export async function resolveRound(
  supabase: SupabaseClient,
  roundId: string,
  brewerId: string,
  cupsMade: number,
  noModifierGain = false,
): Promise<void> {
  const { error } = await supabase.rpc("resolve_round", {
    p_round_id: roundId,
    p_brewer_id: brewerId,
    p_cups_made: cupsMade,
    p_no_modifier_gain: noModifierGain,
  });
  if (error) throw error;
}
