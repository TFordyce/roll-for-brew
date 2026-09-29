import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundRoomId } from "@/lib/supabase/rounds";
import { finalizeLayer, type LayerOutcome } from "@/lib/supabase/roundAdvancement";
import {
  broadcastLayerTied,
  broadcastRoundReplayChanged,
  broadcastRoundRevealed,
} from "@/lib/supabase/realtime";

/**
 * What just happened, from the caller's side (ADR 0008). An event names its
 * trigger only — never a claim about state — and decides which database entry
 * point may run; the locked read in SQL decides whether anything happens.
 *
 * - `reactionWindowChanged`: a pass, a Reaction cast, a card swap, or stall
 *   closing a stranded window. It may only finalize, never open a window.
 *
 * Spec #412 adds `layerRolled`, `pendingDieResolved`, `deferredTargetSet`
 * (#415) and `stallCleared` (#416), which route through advance_layer.
 */
export type AdvanceRoundEvent = "reactionWindowChanged";

/** The module's one injectable seam: its database entry point plus the broadcasts advancing can cause. */
export type AdvanceRoundDeps = {
  finalizeLayer: typeof finalizeLayer;
  getRoundRoomId: typeof getRoundRoomId;
  broadcastRoundRevealed: typeof broadcastRoundRevealed;
  broadcastLayerTied: typeof broadcastLayerTied;
  broadcastRoundReplayChanged: typeof broadcastRoundReplayChanged;
};

const defaultDeps: AdvanceRoundDeps = {
  finalizeLayer,
  getRoundRoomId,
  broadcastRoundRevealed,
  broadcastLayerTied,
  broadcastRoundReplayChanged,
};

/**
 * The Round-advancement module (ADR 0008): a caller does its own write,
 * broadcasts it and revalidates, and raises the event here. This runs the
 * database step the event allows and sends every broadcast the outcome causes
 * — round revealed (plus round replay changed when a replay is now pending)
 * for a brewer, layer tied for a tie, nothing for a noop. Anyone may raise an
 * event, spectators included: nothing here checks who the caller is.
 */
export async function advanceRound(
  supabase: SupabaseClient,
  roundId: string,
  event: AdvanceRoundEvent,
  deps: AdvanceRoundDeps = defaultDeps,
): Promise<LayerOutcome> {
  const outcome = await runEntryPoint(supabase, roundId, event, deps);
  if (outcome.outcome === "noop") return outcome;

  const roomId = await deps.getRoundRoomId(supabase, roundId);

  if (outcome.outcome === "brewer") {
    await deps.broadcastRoundRevealed(supabase, roomId, {
      roundId,
      layer: outcome.layer,
      brewerId: outcome.brewerId,
      cupsMade: outcome.cupsMade,
      rolls: outcome.rolls,
    });
    if (outcome.replayPending) {
      await deps.broadcastRoundReplayChanged(supabase, roomId, { roundId });
    }
  } else {
    await deps.broadcastLayerTied(supabase, roomId, {
      roundId,
      layer: outcome.layer,
      tiedPlayerIds: outcome.tiedPlayerIds,
    });
  }

  return outcome;
}

function runEntryPoint(
  supabase: SupabaseClient,
  roundId: string,
  event: AdvanceRoundEvent,
  deps: AdvanceRoundDeps,
): Promise<LayerOutcome> {
  switch (event) {
    case "reactionWindowChanged":
      return deps.finalizeLayer(supabase, roundId);
  }
}
