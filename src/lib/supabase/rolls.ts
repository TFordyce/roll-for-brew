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
  /**
   * Issue #440: Brewmageddon detail. On a `compel_cast` step, who it compelled;
   * on a `forfeit` step, the Brewmageddon cast it answers and why the card was
   * forfeited. null on every other step.
   */
  compel: {
    compelledPlayerIds: string[];
    compelledByCastId: string | null;
    reason: ForfeitReason | null;
  } | null;
  /**
   * Issue #438: why a Tea Heist (`card_heist`, after `fizzled`) fizzled. null
   * on every other step.
   */
  heistReason: HeistFizzleReason | null;
  /**
   * Issue #426: why a `tea_maker_override` step did nothing (outcome `no-op`),
   * e.g. an inert Last Drip or a PG Tipped whose condition failed. null on
   * every other step.
   */
  overrideReason: OverrideNoopReason | null;
  /**
   * Issue #427: a `tea_maker_override` step whose condition failed (PG
   * Tipped, mode `conditional_chosen`, overrideReason `condition_not_met`) —
   * the condition and the two rolls it compared. null on every other step,
   * including a fired override.
   */
  failedOverrideCondition: {
    condition: OverrideCondition;
    targetRoll: number | null;
    casterRoll: number | null;
  } | null;
  /**
   * Issue #428: a `brewer_immunity` step — which tier of tea-maker selection
   * passed over the immune player, and the declared-number or override card
   * it overrode (null for the lowest-roller and everyone-immune tiers). null
   * on every other step.
   */
  immunity: { tier: ImmunityTier; skippedCardName: string | null } | null;
  /**
   * Issue #430: on a fired Tea Party Revolt `tea_maker_override` step, the
   * lowest roller who picked the brewer. null on every other step.
   */
  pickedBy: string | null;
  /**
   * Issue #429: an `earl_transfer` step — a tea-maker override forced tea on
   * the Earl, so the title passed to the override's caster (the new Earl) and
   * the ex-Earl brews. null on every other step.
   */
  earlTransfer: { newEarlPlayerId: string; forcingCardName: string | null } | null;
  /**
   * Issue #431: a fired Loose Leaf `named_tea_maker_rolloff` step — every
   * roller tied at second-lowest, whom the named holder rolls off against.
   * Empty on every other step, including an inert roll-off (no distinct
   * second-lowest).
   */
  rolloffOpponents: string[];
};

/** Issue #427: a `conditional_chosen` override's condition (effect_params.condition). */
export type OverrideCondition = "target_below_caster";

/**
 * Issue #428: where brewer immunity (ADR 0005 tier 0) skipped a player —
 * a declared-number match, an override target, the lowest roller — or
 * `all_immune`, where immunity gave way to a Tie-Break Reroll.
 */
export type ImmunityTier = "declared_number" | "tea_maker_override" | "lowest_roller" | "all_immune";

/**
 * Issue #440: why a compelled card was forfeited (the `forfeit` row's
 * cast_inputs.reason, set by _forfeit_compelled_card's callers).
 */
export type ForfeitReason = "no_legal_target" | "stall" | "excluded" | "vote" | "timeout";

/** Issue #438: a fizzled Tea Heist's reason (_rr_heist_outcomes). */
export type HeistFizzleReason = "victim_played_first" | "thief_hand_full";

/**
 * Why a `tea_maker_override` did nothing: an inert Last Drip
 * (`prev_round_highest`, #426), a PG Tipped whose condition failed
 * (`conditional_chosen`, #427), or a Tea Party Revolt with no pick (#430) —
 * abandoned by stall, or still pending in a Provisional Recap.
 */
export type OverrideNoopReason =
  | "no_previous_round"
  | "target_absent"
  | "condition_not_met"
  | "pick_abandoned"
  | "pick_pending";

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
  // Issue #440: a compel_cast step's compelled set; a forfeit step's
  // Brewmageddon pointer and reason. Absent on every other step.
  compelled_player_ids?: string[];
  compelled_by?: string | null;
  reason?: ForfeitReason | null;
  // Issue #438: a fizzled Tea Heist step's reason. Absent on every other step.
  heist_reason?: HeistFizzleReason | null;
  // Issue #426: a no-op tea_maker_override step's reason. Absent on every other step.
  override_reason?: OverrideNoopReason | null;
  // Issue #427: a failed conditional tea_maker_override (PG Tipped) — the
  // condition and the rolls it compared. Absent on every other step.
  override_condition?: OverrideCondition | null;
  target_roll?: number | null;
  caster_roll?: number | null;
  // Issue #428: a brewer_immunity step's tier and the card it overrode.
  // Absent on every other step.
  immunity_tier?: ImmunityTier | null;
  skipped_card_name?: string | null;
  // Issue #430: a fired Tea Party Revolt step's picker. Absent on every other step.
  picked_by?: string | null;
  // Issue #429: an earl_transfer step's new Earl and the forcing card.
  // Absent on every other step.
  new_earl_player_id?: string | null;
  forcing_card_name?: string | null;
  // Issue #431: a fired named_tea_maker_rolloff step's opponents. Absent on
  // every other step.
  rolloff_opponent_ids?: string[] | null;
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
    compel:
      raw.display_kind === "compel_cast" || raw.display_kind === "forfeit"
        ? {
            compelledPlayerIds: raw.compelled_player_ids ?? [],
            compelledByCastId: raw.compelled_by ?? null,
            reason: raw.reason ?? null,
          }
        : null,
    heistReason: raw.heist_reason ?? null,
    overrideReason: raw.override_reason ?? null,
    failedOverrideCondition:
      raw.override_reason === "condition_not_met" && raw.override_condition
        ? {
            condition: raw.override_condition,
            targetRoll: raw.target_roll ?? null,
            casterRoll: raw.caster_roll ?? null,
          }
        : null,
    immunity: raw.immunity_tier
      ? { tier: raw.immunity_tier, skippedCardName: raw.skipped_card_name ?? null }
      : null,
    pickedBy: raw.picked_by ?? null,
    earlTransfer: raw.new_earl_player_id
      ? { newEarlPlayerId: raw.new_earl_player_id, forcingCardName: raw.forcing_card_name ?? null }
      : null,
    rolloffOpponents: raw.rolloff_opponent_ids ?? [],
  };
}

/**
 * Parses a raw `rounds.resolution_trace` JSON value (an array of 0080-shape
 * step objects, or null/absent on a pre-rebuild resolved round) into typed
 * steps. Used by the Round Recap reader (getRoundRecap, issue #314); the
 * resolver itself runs inside Layer finalization (finalize_layer).
 */
export function parseResolutionTrace(raw: unknown): ResolutionTraceStep[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawTraceStep[]).map(toTraceStep);
}
