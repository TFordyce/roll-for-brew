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
   * Issue #438: why a Tea Heist (`card_heist`, after `fizzled`) fizzled. null
   * on every other step.
   */
  heistReason: HeistFizzleReason | null;
};

/** Issue #438: a fizzled Tea Heist's reason (_rr_heist_outcomes). */
export type HeistFizzleReason = "victim_played_first" | "thief_hand_full";

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
  // Issue #438: a fizzled Tea Heist step's reason. Absent on every other step.
  heist_reason?: HeistFizzleReason | null;
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
    heistReason: raw.heist_reason ?? null,
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
