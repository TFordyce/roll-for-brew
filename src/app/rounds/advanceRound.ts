import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundRoomId } from "@/lib/supabase/rounds";
import {
  advanceLayer,
  finalizeLayer,
  type FinalizationOutcome,
  type LayerOutcome,
} from "@/lib/supabase/roundAdvancement";
import {
  broadcastLayerRollsRevealed,
  broadcastLayerTied,
  broadcastRoundReplayChanged,
  broadcastRoundRevealed,
} from "@/lib/supabase/realtime";

/**
 * What just happened, from the caller's side (ADR 0008). An event names its
 * trigger only — never a claim about state — and decides which database entry
 * point may run; the locked read in SQL decides whether anything happens.
 *
 * - `reactionWindowChanged`: a pass, a Reaction cast, or a card swap. It may
 *   only finalize, never open a window.
 * - `layerRolled`: a roll landed — the player's own, a manual entry, a Proxy
 *   Roll, or a Test Room roll-as.
 * - `pendingDieResolved`: a Pending Spell Die was given its value.
 * - `deferredTargetSet`: a deferred spell-cast target was named.
 * - `stallCleared`: stall enforcement cleared a blockage (excluded a
 *   non-roller, auto-resolved a Pending Spell Die, abandoned a Deferred
 *   Forced-Reroll Target, or closed a stranded window).
 *
 * Every event but the first routes through advance_layer.
 */
export type AdvanceRoundEvent =
  | "reactionWindowChanged"
  | "layerRolled"
  | "pendingDieResolved"
  | "deferredTargetSet"
  | "stallCleared";

/** The module's one injectable seam: its database entry points plus the broadcasts advancing can cause. */
export type AdvanceRoundDeps = {
  advanceLayer: typeof advanceLayer;
  finalizeLayer: typeof finalizeLayer;
  getRoundRoomId: typeof getRoundRoomId;
  broadcastLayerRollsRevealed: typeof broadcastLayerRollsRevealed;
  broadcastRoundRevealed: typeof broadcastRoundRevealed;
  broadcastLayerTied: typeof broadcastLayerTied;
  broadcastRoundReplayChanged: typeof broadcastRoundReplayChanged;
};

const defaultDeps: AdvanceRoundDeps = {
  advanceLayer,
  finalizeLayer,
  getRoundRoomId,
  broadcastLayerRollsRevealed,
  broadcastRoundRevealed,
  broadcastLayerTied,
  broadcastRoundReplayChanged,
};

/**
 * The Round-advancement module (ADR 0008): a caller does its own write,
 * broadcasts it and revalidates, and raises the event here. This runs the
 * database step the event allows and sends every broadcast the outcome causes
 * — layer rolls revealed when this call first found the Layer complete, then
 * round revealed (plus round replay changed when a replay is now pending) for
 * a brewer, layer tied for a tie, nothing for a noop or a window left open.
 * Anyone may raise an event, spectators included: nothing here checks who the
 * caller is.
 */
export async function advanceRound(
  supabase: SupabaseClient,
  roundId: string,
  event: AdvanceRoundEvent,
  deps: AdvanceRoundDeps = defaultDeps,
): Promise<LayerOutcome> {
  const outcome = await runEntryPoint(supabase, roundId, event, deps);
  const finalization = outcome.outcome === "windowOpened" ? outcome.finalization : outcome;
  const finalized = finalization !== null && finalization.outcome !== "noop";
  if (!outcome.layerRolls && !finalized) return outcome;

  const roomId = await deps.getRoundRoomId(supabase, roundId);

  if (outcome.layerRolls) {
    await deps.broadcastLayerRollsRevealed(supabase, roomId, { roundId, ...outcome.layerRolls });
  }
  if (finalized) {
    await broadcastFinalization(supabase, roomId, roundId, finalization, deps);
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
    case "layerRolled":
    case "pendingDieResolved":
    case "deferredTargetSet":
    case "stallCleared":
      return deps.advanceLayer(supabase, roundId);
  }
}

async function broadcastFinalization(
  supabase: SupabaseClient,
  roomId: string,
  roundId: string,
  finalization: Exclude<FinalizationOutcome, { outcome: "noop" }>,
  deps: AdvanceRoundDeps,
): Promise<void> {
  if (finalization.outcome === "brewer") {
    await deps.broadcastRoundRevealed(supabase, roomId, {
      roundId,
      layer: finalization.layer,
      brewerId: finalization.brewerId,
      cupsMade: finalization.cupsMade,
      rolls: finalization.rolls,
    });
    if (finalization.replayPending) {
      await deps.broadcastRoundReplayChanged(supabase, roomId, { roundId });
    }
  } else {
    await deps.broadcastLayerTied(supabase, roomId, {
      roundId,
      layer: finalization.layer,
      tiedPlayerIds: finalization.tiedPlayerIds,
    });
  }
}
