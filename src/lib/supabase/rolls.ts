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

/**
 * One step of a round's Resolution Trace (migration 0078, ADR 0005): the
 * structured record resolve_round emits for every effect it applied while
 * composing modifiers and picking the brewer. The renderer (#314) owns the
 * wording; SQL emits only these fields.
 */
/**
 * A Trace step's outcome. `applied`/`no-op` come from the 6-arg
 * _rr_trace_step (before === after ⇒ `no-op`); `blocked` (issue #309, a ward
 * pre-empted the effect) and `backfired` (issue #308, a nat-1 counterspell)
 * are set explicitly via the 7-arg form's `outcome` override.
 */
export type TraceStepOutcome = "applied" | "no-op" | "blocked" | "backfired";

export type ResolutionTraceStep = {
  index: number;
  displayKind: string;
  sourceCast: {
    castId: string | null;
    activeEffectId: string | null;
    cardName: string | null;
    casterPlayerId: string | null;
  };
  targetPlayer: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: TraceStepOutcome;
  /** Issue #308: this step's source cast was negated by a counter — render struck. */
  negated: boolean;
  /** Issue #308: a re-application of a backfired counter's transform onto its own caster. */
  backfire: boolean;
  /** Issue #308: a contested_negate step's d20 roll and DC, when present. */
  contest: { d20: number | null; dc: number | null } | null;
  /** Issue #309: which ward blocked this step, when `outcome === "blocked"`. */
  ward: { wardCastId: string | null; wardCardName: string | null } | null;
  /** Issue #311: a persistent (rest-of-day) modifier transfer/spend step. */
  restOfDay: boolean;
  /** Issue #318: chosen-pair roll transform op — "swap" | "min" | "max". */
  pairOp: string | null;
  /**
   * Issue #319: conditional-advantage (Gambler's Infusion) detail — the first
   * die and which branch it selected. null on every other step.
   */
  condition: {
    firstDie: number;
    branch: "advantage" | "disadvantage" | "none";
    advantageAtOrAbove: number;
    disadvantageAtOrBelow: number;
  } | null;
  /**
   * Issue #289: per-round dice tick (Calami-Tea) detail — the die size and the
   * value actually rolled against the roll this round. null on every other step.
   */
  diceTick: { die: number | null; rolled: number } | null;
};

/**
 * The outcome of the authoritative layer-0 resolver, resolve_round(uuid)
 * (migration 0078). `brewer` carries the picked brewer plus the cups-made
 * count and whether a tea_maker_override suppressed their modifier gain;
 * `tie` carries the tied roster that must reroll in the next layer. Either
 * way `trace` is the round's Resolution Trace (empty for a tie-break reroll
 * layer, which bypasses all spell logic).
 */
export type ResolveRoundOutcome =
  | {
      outcome: "brewer";
      layer: number;
      brewerId: string;
      brewerSource: string;
      cupsMade: number;
      noModifierGain: boolean;
      trace: ResolutionTraceStep[];
    }
  | {
      outcome: "tie";
      layer: number;
      tiedPlayerIds: string[];
      cupsMade: number;
      trace: ResolutionTraceStep[];
    };

type RawTraceStep = {
  index: number;
  display_kind: string;
  source_cast: {
    cast_id: string | null;
    active_effect_id: string | null;
    card_name: string | null;
    caster_player_id: string | null;
  };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  // 6-arg form always emits "applied" | "no-op"; the 7-arg form may override
  // to "blocked" | "backfired". All the keys below are 7-arg extras merged in
  // at the top level (migration 0080) and absent on a plain 6-arg step.
  outcome: TraceStepOutcome;
  negated?: boolean;
  backfire?: boolean;
  dc_d20?: number | null;
  dc?: number | null;
  ward_cast_id?: string | null;
  ward_card_name?: string | null;
  rest_of_day?: boolean;
  op?: string | null;
  // Issue #319: a conditional-advantage step (Gambler's Infusion) — which
  // branch the caster's first die selected, and the thresholds it was tested
  // against. Absent on every other step.
  condition?: {
    first_die: number;
    branch: "advantage" | "disadvantage" | "none";
    advantage_at_or_above: number;
    disadvantage_at_or_below: number;
  } | null;
  // Issue #289: a per_round_dice_tick step (Calami-Tea) — the die size and the
  // value rolled against the roll this round. Absent on every other step.
  die?: number | null;
  rolled?: number | null;
};

type RawResolveRoundOutcome = {
  outcome: "brewer" | "tie";
  layer: number;
  brewer_id: string | null;
  brewer_source: string | null;
  tied_player_ids: string[] | null;
  cups_made: number;
  no_modifier_gain: boolean;
  trace: RawTraceStep[];
};

function toTraceStep(raw: RawTraceStep): ResolutionTraceStep {
  return {
    index: raw.index,
    displayKind: raw.display_kind,
    sourceCast: {
      castId: raw.source_cast?.cast_id ?? null,
      activeEffectId: raw.source_cast?.active_effect_id ?? null,
      cardName: raw.source_cast?.card_name ?? null,
      casterPlayerId: raw.source_cast?.caster_player_id ?? null,
    },
    targetPlayer: raw.target_player,
    before: raw.before,
    after: raw.after,
    outcome: raw.outcome,
    negated: raw.negated ?? false,
    backfire: raw.backfire ?? false,
    contest:
      raw.dc_d20 != null || raw.dc != null
        ? { d20: raw.dc_d20 ?? null, dc: raw.dc ?? null }
        : null,
    ward:
      raw.ward_cast_id != null || raw.ward_card_name != null
        ? { wardCastId: raw.ward_cast_id ?? null, wardCardName: raw.ward_card_name ?? null }
        : null,
    restOfDay: raw.rest_of_day ?? false,
    pairOp: raw.op ?? null,
    condition: raw.condition
      ? {
          firstDie: raw.condition.first_die,
          branch: raw.condition.branch,
          advantageAtOrAbove: raw.condition.advantage_at_or_above,
          disadvantageAtOrBelow: raw.condition.disadvantage_at_or_below,
        }
      : null,
    diceTick:
      raw.rolled != null ? { die: raw.die ?? null, rolled: raw.rolled } : null,
  };
}

/**
 * Parses a raw `rounds.resolution_trace` JSON value (an array of 0080-shape
 * step objects, or null/absent on a pre-rebuild resolved round) into typed
 * steps. Shared by resolveRoundOutcome above and the Round Recap reader
 * (getRoundRecap, issue #314).
 */
export function parseResolutionTrace(raw: unknown): ResolutionTraceStep[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawTraceStep[]).map(toTraceStep);
}

/**
 * Calls the authoritative resolve_round(uuid) RPC (migration 0078): composes
 * every player's round modifier, applies lowest_gains_highest_modifier as
 * modifier math, resolves tea_maker_override / declared_number precedence,
 * and picks the brewer (or the tied roster) — writing the Resolution Trace
 * onto rounds.resolution_trace. It does NOT flip the round to resolved; the
 * caller persists a brewer via resolveRound (the 4-arg RPC) or a tie via
 * advanceRoundLayer, exactly as before.
 */
export async function resolveRoundOutcome(
  supabase: SupabaseClient,
  roundId: string,
): Promise<ResolveRoundOutcome> {
  const { data, error } = await supabase.rpc("resolve_round", { p_round_id: roundId });
  if (error) throw error;

  const raw = data as RawResolveRoundOutcome;
  const trace = (raw.trace ?? []).map(toTraceStep);
  const cupsMade = raw.cups_made;

  if (raw.outcome === "tie") {
    if (!raw.tied_player_ids?.length) {
      throw new Error("resolve_round returned a tie with no tied_player_ids");
    }
    return { outcome: "tie", layer: raw.layer, tiedPlayerIds: raw.tied_player_ids, cupsMade, trace };
  }

  if (!raw.brewer_id) {
    throw new Error("resolve_round returned a brewer outcome with no brewer_id");
  }

  return {
    outcome: "brewer",
    layer: raw.layer,
    brewerId: raw.brewer_id,
    brewerSource: raw.brewer_source ?? "default",
    cupsMade,
    noModifierGain: raw.no_modifier_gain,
    trace,
  };
}
