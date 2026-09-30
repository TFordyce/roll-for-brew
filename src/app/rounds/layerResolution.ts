import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundRoomId } from "@/lib/supabase/rounds";
import { advanceRoundLayer, resolveRound, resolveRoundOutcome, type CompletedLayer } from "@/lib/supabase/rolls";
import { broadcastLayerTied, broadcastRoundReplayChanged, broadcastRoundRevealed } from "@/lib/supabase/realtime";
import { recordPendingRoundReplay } from "@/lib/supabase/roundReplay";
import { resolveDeclaredNumberTeaMaker } from "@/lib/supabase/reactionWindow";

/**
 * applyLayerOutcome's persistence/broadcast calls, factored out as an
 * injectable seam: production callers get defaultDeps (the real
 * supabase-backed functions below), while layerResolution.test.ts passes
 * fakes so it can assert on the brewer/tie orchestration without a live
 * Supabase client.
 *
 * The outcome math itself (modifier composition, lowest_gains_highest_
 * modifier, tea_maker_override / declared_number, the lowest-roll pick) now
 * lives in the authoritative SQL resolve_round(uuid) behind resolveRoundOutcome
 * (migration 0078, issue #305) — this module only orchestrates persistence
 * and broadcast around its result.
 */
export type ApplyLayerOutcomeDeps = {
  getRoundRoomId: typeof getRoundRoomId;
  resolveRoundOutcome: typeof resolveRoundOutcome;
  resolveDeclaredNumberTeaMaker: typeof resolveDeclaredNumberTeaMaker;
  resolveRound: typeof resolveRound;
  advanceRoundLayer: typeof advanceRoundLayer;
  broadcastRoundRevealed: typeof broadcastRoundRevealed;
  broadcastLayerTied: typeof broadcastLayerTied;
  recordPendingRoundReplay: typeof recordPendingRoundReplay;
  broadcastRoundReplayChanged: typeof broadcastRoundReplayChanged;
};

const defaultDeps: ApplyLayerOutcomeDeps = {
  getRoundRoomId,
  resolveRoundOutcome,
  resolveDeclaredNumberTeaMaker,
  resolveRound,
  advanceRoundLayer,
  broadcastRoundRevealed,
  broadcastLayerTied,
  recordPendingRoundReplay,
  broadcastRoundReplayChanged,
};

/**
 * Runs the resolution engine over a layer that's already known to be
 * complete and persists/broadcasts whichever outcome it computes — a single
 * brewer, or the next reroll layer. Only stall enforcement still calls this
 * (with getCompletedLayerRollsForStallResolution); every other caller raises
 * an advanceRound event (ADR 0008), and #416 moves stall over too.
 */
export async function applyLayerOutcome(
  supabase: SupabaseClient,
  roundId: string,
  completedLayer: CompletedLayer,
  deps: ApplyLayerOutcomeDeps = defaultDeps,
): Promise<void> {
  const { rolls, layer } = completedLayer;

  // The authoritative SQL resolver owns all the outcome math (issue #305):
  // modifier composition, lowest_gains_highest_modifier as modifier math,
  // tea_maker_override / declared_number precedence, and the lowest-roll
  // pick — plus emitting the Resolution Trace onto rounds.resolution_trace.
  // A tie-break reroll layer (layer > 0) bypasses all spell logic inside it
  // (issue #219). It is a pure read: it does not flip the round to resolved
  // and does not burn the declared_number one-shot.
  const result = await deps.resolveRoundOutcome(supabase, roundId);

  const roomId = await deps.getRoundRoomId(supabase, roundId);

  if (result.outcome === "brewer") {
    // Inscribed Saucer's declared number is a one-time trigger: resolve_round
    // only reads it, so burn it here now that the brewer it named is being
    // committed. Keeping this out of resolve_round is what lets that function
    // stay a pure, idempotent function of its inputs (ADR 0005).
    if (result.brewerSource === "declared_number") {
      await deps.resolveDeclaredNumberTeaMaker(supabase, roundId, layer);
    }

    // cups_made is the number of cups the brewer owes everyone who played
    // this round — the round's original participant count (computed in
    // resolve_round), not the narrower tied subset that rolled the final
    // layer.
    const cupsMade = result.cupsMade;

    // Only passed when true, so an ordinary brewing round's resolveRound
    // call keeps its original 4-arg shape (existing tests assert on it
    // exactly) — noModifierGain only ever comes from a tea_maker_override
    // cast (Drip Tray).
    if (result.noModifierGain) {
      await deps.resolveRound(supabase, roundId, result.brewerId, cupsMade, true);
    } else {
      await deps.resolveRound(supabase, roundId, result.brewerId, cupsMade);
    }

    await deps.broadcastRoundRevealed(supabase, roomId, {
      roundId,
      layer,
      brewerId: result.brewerId,
      cupsMade,
      rolls: rolls.map((r) => ({
        playerId: r.playerId,
        value: r.value,
        discardedValue: r.discardedValue,
        enteredByAdmin: r.enteredByAdmin,
      })),
    });

    // Round Replay — Time for Brew (issue #315, spec §11). The round has now
    // resolved and announced normally. If it carries a surviving (non-negated)
    // round_replay cast, record the caster's pending scrap/keep decision — a
    // no-op for every ordinary round — and nudge every device to surface the
    // blocking prompt. A tie-break reroll layer (the `else` branch below)
    // never reaches here, matching "resolves and announces normally" being a
    // layer-0 brewer outcome.
    const replayPending = await deps.recordPendingRoundReplay(supabase, roundId);
    if (replayPending) {
      await deps.broadcastRoundReplayChanged(supabase, roomId, { roundId });
    }
  } else {
    const nextLayer = await deps.advanceRoundLayer(supabase, roundId, result.tiedPlayerIds);

    await deps.broadcastLayerTied(supabase, roomId, {
      roundId,
      layer: nextLayer,
      tiedPlayerIds: result.tiedPlayerIds,
    });
  }
}

