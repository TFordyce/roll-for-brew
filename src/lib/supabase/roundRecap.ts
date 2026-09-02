import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseResolutionTrace,
  type CompletedLayer,
  type LayerRoll,
  type ResolutionTraceStep,
} from "@/lib/supabase/rolls";

/**
 * One entry in a round's cast list, as returned by get_round_recap (migration
 * 0086). `phase` is where the cast was armed; `onStack` is a coarse live-phase
 * flag the cast strip falls back on before a Resolution Trace exists. Once the
 * round is resolved the renderer derives each cast's state from the Trace and
 * ignores `onStack`.
 */
export type RoundRecapCast = {
  castId: string;
  seq: number;
  cardName: string;
  casterPlayerId: string;
  targetPlayerId: string | null;
  targetPending: boolean;
  effectKind: string | null;
  phase: "preroll" | "reaction";
  negated: boolean;
  redirectedToCastId: string | null;
  onStack: boolean;
};

/**
 * One retained scrapped replay generation (issue #352), snapshotted into
 * rounds.scrapped_generations by _rr_scrap_round (migration 0090) just before
 * the scrap delete pass removes its rows. Generation 0 is the original attempt;
 * a replayed round has exactly one entry (the deck holds one Time for Brew).
 *
 * It carries no cast list — the scrap deletes generation 0's spell_casts — but
 * every Trace step embeds its own source card + caster, so the step rows still
 * render in full; only the tap-to-filter cast strip is absent for a scrapped
 * generation.
 */
export type ScrappedGeneration = {
  generation: number;
  brewerId: string | null;
  cupsMade: number | null;
  brewerModifierGain: number | null;
  resolvedAt: string | null;
  trace: ResolutionTraceStep[];
  /**
   * The generation's rolls grouped by layer, oldest first — layer 0 plus any
   * tie-break reroll layers. Same shape as getRoundLayerHistory, so
   * buildRerollChain consumes it directly.
   */
  layers: CompletedLayer[];
  /**
   * The generation's own per-layer participant set (issue #220's
   * round_layer_participants), snapshotted before the scrap cleared it — the
   * ordering source for the layer-0 roll list, independent of generation 1's
   * roster.
   */
  layerParticipants: { layer: number; playerId: string }[];
};

export type RoundRecapData = {
  resolved: boolean;
  /**
   * The layer-0 resolver outcome for a resolved round: "tie" when layer 0
   * tied and the round was decided by tie-break reroll layers (the Recap ends
   * at the tie), "brewer" otherwise. null while the round is still live.
   */
  layerZeroOutcome: "brewer" | "tie" | null;
  trace: ResolutionTraceStep[];
  casts: RoundRecapCast[];
  /**
   * Issue #352: every scrapped replay generation of this round, oldest first
   * (generation 0 = the original attempt). Empty for a round never replayed.
   */
  scrappedGenerations: ScrappedGeneration[];
};

type RawRecapCast = {
  cast_id: string;
  seq: number;
  card_name: string;
  caster_player_id: string;
  target_player_id: string | null;
  target_pending: boolean;
  effect_kind: string | null;
  phase: "preroll" | "reaction";
  negated: boolean;
  redirected_to_cast_id: string | null;
  on_stack: boolean;
};

type RawScrappedGenerationRoll = {
  player_id: string;
  layer: number;
  value: number;
  modifier_snapshot: number | null;
  discarded_value: number | null;
  entered_by_admin: boolean | null;
};

type RawScrappedGeneration = {
  generation: number;
  brewer_id: string | null;
  cups_made: number | null;
  brewer_modifier_gain: number | null;
  resolved_at: string | null;
  resolution_trace: unknown;
  rolls: RawScrappedGenerationRoll[] | null;
  layer_participants: { layer: number; player_id: string }[] | null;
};

type RawRoundRecap = {
  resolved: boolean;
  layer_zero_outcome: "brewer" | "tie" | null;
  trace: unknown;
  casts: RawRecapCast[] | null;
  scrapped_generations: RawScrappedGeneration[] | null;
};

/**
 * Group a scrapped generation's flat roll snapshot into ordered per-layer
 * buckets — the same shape getRoundLayerHistory returns, so buildRerollChain
 * can walk a scrapped generation's tie-break layers unchanged.
 */
function groupScrappedRollsByLayer(rows: RawScrappedGenerationRoll[]): CompletedLayer[] {
  const byLayer = new Map<number, LayerRoll[]>();
  for (const row of rows) {
    const bucket = byLayer.get(row.layer) ?? [];
    bucket.push({
      playerId: row.player_id,
      value: row.value,
      modifierSnapshot: row.modifier_snapshot ?? 0,
      discardedValue: row.discarded_value ?? null,
      enteredByAdmin: row.entered_by_admin ?? false,
    });
    byLayer.set(row.layer, bucket);
  }
  return [...byLayer.entries()].sort(([a], [b]) => a - b).map(([layer, rolls]) => ({ layer, rolls }));
}

function parseScrappedGeneration(raw: RawScrappedGeneration): ScrappedGeneration {
  return {
    generation: raw.generation,
    brewerId: raw.brewer_id ?? null,
    cupsMade: raw.cups_made ?? null,
    brewerModifierGain: raw.brewer_modifier_gain ?? null,
    resolvedAt: raw.resolved_at ?? null,
    trace: parseResolutionTrace(raw.resolution_trace),
    layers: groupScrappedRollsByLayer(raw.rolls ?? []),
    layerParticipants: (raw.layer_participants ?? []).map((lp) => ({
      layer: lp.layer,
      playerId: lp.player_id,
    })),
  };
}

/**
 * Calls the get_round_recap RPC (migration 0086, issue #314): the persisted
 * Resolution Trace plus the round's full cast list with per-cast phase and
 * coarse live state. Everything the Round Recap ("the Ledger") renderer needs
 * in one participant-gated round trip. Returns null on any error so the caller
 * can fall back to the plain reveal — the Recap is additive.
 */
export async function getRoundRecap(
  supabase: SupabaseClient,
  roundId: string,
): Promise<RoundRecapData | null> {
  const { data, error } = await supabase.rpc("get_round_recap", { p_round_id: roundId });
  if (error || !data) {
    // A participant-gate rejection is expected for a round the viewer sat out
    // (room history shows "no recap available"); anything else is a real fault
    // worth a console line before the additive Recap falls back silently.
    if (error && error.code !== "P0001") {
      console.error("getRoundRecap failed", error);
    }
    return null;
  }

  const raw = data as RawRoundRecap;
  return {
    resolved: raw.resolved,
    layerZeroOutcome: raw.layer_zero_outcome ?? null,
    trace: parseResolutionTrace(raw.trace),
    scrappedGenerations: (raw.scrapped_generations ?? []).map(parseScrappedGeneration),
    casts: (raw.casts ?? []).map((c) => ({
      castId: c.cast_id,
      seq: c.seq,
      cardName: c.card_name,
      casterPlayerId: c.caster_player_id,
      targetPlayerId: c.target_player_id,
      targetPending: c.target_pending,
      effectKind: c.effect_kind,
      phase: c.phase,
      negated: c.negated,
      redirectedToCastId: c.redirected_to_cast_id,
      onStack: c.on_stack,
    })),
  };
}
