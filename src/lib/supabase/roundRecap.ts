import type { SupabaseClient } from "@supabase/supabase-js";
import { parseResolutionTrace, type ResolutionTraceStep } from "@/lib/supabase/rolls";

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

export type RoundRecapData = {
  resolved: boolean;
  trace: ResolutionTraceStep[];
  casts: RoundRecapCast[];
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

type RawRoundRecap = {
  resolved: boolean;
  trace: unknown;
  casts: RawRecapCast[] | null;
};

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
  if (error || !data) return null;

  const raw = data as RawRoundRecap;
  return {
    resolved: raw.resolved,
    trace: parseResolutionTrace(raw.trace),
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
