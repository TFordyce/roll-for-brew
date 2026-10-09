import type { SupabaseClient } from "@supabase/supabase-js";

export type LayerRoll = {
  playerId: string;
  value: number;
  modifierSnapshot: number;
  discardedValue: number | null;
  enteredByAdmin: boolean;
};

export type CompletedLayer = {
  layer: number;
  rolls: LayerRoll[];
};

export async function submitRoll(supabase: SupabaseClient, roundId: string): Promise<number> {
  const { data, error } = await supabase.rpc("submit_roll", { p_round_id: roundId });
  if (error) throw error;
  return data as number;
}

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
  negated: boolean;
  backfire: boolean;
  contest: { d20: number | null; dc: number | null } | null;
  ward: { wardCastId: string | null; wardCardName: string | null } | null;
  restOfDay: boolean;
  pairOp: string | null;
  condition: {
    firstDie: number;
    branch: "advantage" | "disadvantage" | "none";
    advantageAtOrAbove: number;
    disadvantageAtOrBelow: number;
  } | null;
  diceTick: { die: number | null; rolled: number } | null;
  compel: {
    compelledPlayerIds: string[];
    compelledByCastId: string | null;
    reason: ForfeitReason | null;
  } | null;
  heistReason: HeistFizzleReason | null;
  redirectTrigger: DrawRedirectTrigger | null;
  overrideReason: OverrideNoopReason | null;
  failedOverrideCondition: {
    condition: OverrideCondition;
    targetRoll: number | null;
    casterRoll: number | null;
  } | null;
  immunity: { tier: ImmunityTier; skippedCardName: string | null } | null;
  pickedBy: string | null;
  earlTransfer: { newEarlPlayerId: string; forcingCardName: string | null } | null;
  rolloffOpponents: string[];
  passedOver: LastDripPassedOver[];
  courageToken: boolean;
};

export type OverrideCondition = "target_below_caster";

export type ImmunityTier = "declared_number" | "tea_maker_override" | "lowest_roller" | "all_immune";

export type ForfeitReason = "no_legal_target" | "stall" | "excluded" | "vote" | "timeout";

export type LastDripPassedOverReason = "absent" | "roll_exempt";

export type LastDripPassedOver = { playerId: string; reason: LastDripPassedOverReason };

export type RawLastDripPassedOver = { player_id: string; reason: LastDripPassedOverReason };

export function parseLastDripPassedOver(raw: RawLastDripPassedOver[] | null | undefined): LastDripPassedOver[] {
  return (raw ?? []).map((p) => ({ playerId: p.player_id, reason: p.reason }));
}

export type LastDripPreview = {
  targetPlayerId: string | null;
  reason: "no_previous_round" | "no_eligible_roller" | null;
  passedOver: LastDripPassedOver[];
};

export type HeistFizzleReason = "victim_played_first" | "thief_hand_full";

export type DrawRedirectTrigger = "next_crit" | "next_draw";

export type OverrideNoopReason =
  | "no_previous_round"
  | "no_eligible_roller"
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
  outcome: TraceStepOutcome;
  negated?: boolean;
  backfire?: boolean;
  dc_d20?: number | null;
  dc?: number | null;
  ward_cast_id?: string | null;
  ward_card_name?: string | null;
  rest_of_day?: boolean;
  op?: string | null;
  condition?: {
    first_die: number;
    branch: "advantage" | "disadvantage" | "none";
    advantage_at_or_above: number;
    disadvantage_at_or_below: number;
  } | null;
  die?: number | null;
  rolled?: number | null;
  compelled_player_ids?: string[];
  compelled_by?: string | null;
  reason?: ForfeitReason | null;
  heist_reason?: HeistFizzleReason | null;
  redirect_trigger?: DrawRedirectTrigger | null;
  override_reason?: OverrideNoopReason | null;
  override_condition?: OverrideCondition | null;
  target_roll?: number | null;
  caster_roll?: number | null;
  immunity_tier?: ImmunityTier | null;
  skipped_card_name?: string | null;
  picked_by?: string | null;
  new_earl_player_id?: string | null;
  forcing_card_name?: string | null;
  rolloff_opponent_ids?: string[] | null;
  passed_over?: RawLastDripPassedOver[] | null;
  courage_token?: boolean;
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
    redirectTrigger: raw.redirect_trigger ?? null,
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
    passedOver: parseLastDripPassedOver(raw.passed_over),
    courageToken: raw.courage_token ?? false,
  };
}

export function parseResolutionTrace(raw: unknown): ResolutionTraceStep[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawTraceStep[]).map(toTraceStep);
}
