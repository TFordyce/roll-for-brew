import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseResolutionTrace,
  type CompletedLayer,
  type LayerRoll,
  type ResolutionTraceStep,
} from "@/lib/supabase/rolls";

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
  compelledByCastId: string | null;
  onStack: boolean;
};

export type ScrappedGeneration = {
  generation: number;
  brewerId: string | null;
  cupsMade: number | null;
  brewerModifierGain: number | null;
  resolvedAt: string | null;
  trace: ResolutionTraceStep[];
  summary: ResolutionSummaryEntry[] | null;
  layers: CompletedLayer[];
  layerParticipants: LayerParticipant[];
};

export type LayerParticipant = { layer: number; playerId: string };

export type ResolutionSummaryEntry = {
  playerId: string;
  roll: number;
  snapshot: number;
  composed: number;
  total: number;
  nat: "nat1" | "nat20" | null;
  diceReduced: boolean;
};

export type RoundRecapData = {
  resolved: boolean;
  layerZeroOutcome: "brewer" | "tie" | null;
  trace: ResolutionTraceStep[];
  summary: ResolutionSummaryEntry[] | null;
  provisional: boolean;
  casts: RoundRecapCast[];
  scrappedGenerations: ScrappedGeneration[];
  layers: CompletedLayer[];
  layerParticipants: LayerParticipant[];
  reactionSkips: ReactionSkip[];
};

export type ReactionSkip = { playerId: string; reason: "vote" | "timeout" };

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
  compelled_by_cast_id?: string | null;
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
  players?: RawSummaryEntry[] | null;
  rolls: RawScrappedGenerationRoll[] | null;
  layer_participants: { layer: number; player_id: string }[] | null;
};

type RawSummaryEntry = {
  player_id: string;
  roll: number;
  snapshot: number;
  composed: number;
  total: number;
  nat: "nat1" | "nat20" | null;
  dice_reduced: boolean | null;
};

type RawRoundRecap = {
  resolved: boolean;
  layer_zero_outcome: "brewer" | "tie" | null;
  trace: unknown;
  players: RawSummaryEntry[] | null;
  provisional: boolean | null;
  casts: RawRecapCast[] | null;
  scrapped_generations: RawScrappedGeneration[] | null;
  layers: RawScrappedGenerationRoll[] | null;
  layer_participants: { layer: number; player_id: string }[] | null;
  reaction_skips: { player_id: string; reason: "vote" | "timeout" }[] | null;
};

function groupRollsByLayer(rows: RawScrappedGenerationRoll[]): CompletedLayer[] {
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

export function parseResolutionSummary(raw: RawSummaryEntry[] | null | undefined): ResolutionSummaryEntry[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((p) => ({
    playerId: p.player_id,
    roll: Number(p.roll),
    snapshot: Number(p.snapshot),
    composed: Number(p.composed),
    total: Number(p.total),
    nat: p.nat ?? null,
    diceReduced: p.dice_reduced ?? false,
  }));
}

function parseLayerParticipants(
  raw: { layer: number; player_id: string }[] | null,
): LayerParticipant[] {
  return (raw ?? []).map((lp) => ({ layer: lp.layer, playerId: lp.player_id }));
}

function parseScrappedGeneration(raw: RawScrappedGeneration): ScrappedGeneration {
  return {
    generation: raw.generation,
    brewerId: raw.brewer_id ?? null,
    cupsMade: raw.cups_made ?? null,
    brewerModifierGain: raw.brewer_modifier_gain ?? null,
    resolvedAt: raw.resolved_at ?? null,
    trace: parseResolutionTrace(raw.resolution_trace),
    summary: parseResolutionSummary(raw.players),
    layers: groupRollsByLayer(raw.rolls ?? []),
    layerParticipants: parseLayerParticipants(raw.layer_participants),
  };
}

export async function getRoundRecap(
  supabase: SupabaseClient,
  roundId: string,
): Promise<RoundRecapData | null> {
  const { data, error } = await supabase.rpc("get_round_recap", { p_round_id: roundId });
  if (error || !data) {
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
    summary: parseResolutionSummary(raw.players),
    provisional: raw.provisional ?? false,
    scrappedGenerations: (raw.scrapped_generations ?? []).map(parseScrappedGeneration),
    layers: groupRollsByLayer(raw.layers ?? []),
    layerParticipants: parseLayerParticipants(raw.layer_participants),
    reactionSkips: (raw.reaction_skips ?? []).map((r) => ({ playerId: r.player_id, reason: r.reason })),
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
      compelledByCastId: c.compelled_by_cast_id ?? null,
      onStack: c.on_stack,
    })),
  };
}
