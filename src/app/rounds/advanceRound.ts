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
  broadcastRoomChanged,
  broadcastRoundRevealed,
} from "@/lib/supabase/realtime";

export type AdvanceRoundEvent =
  | "reactionWindowChanged"
  | "layerRolled"
  | "pendingDieResolved"
  | "deferredTargetSet"
  | "revoltPickMade"
  | "stallCleared"
  | "roundClosed"
  | "lateDeclared";

export type AdvanceRoundDeps = {
  advanceLayer: typeof advanceLayer;
  finalizeLayer: typeof finalizeLayer;
  getRoundRoomId: typeof getRoundRoomId;
  broadcastLayerRollsRevealed: typeof broadcastLayerRollsRevealed;
  broadcastRoundRevealed: typeof broadcastRoundRevealed;
  broadcastLayerTied: typeof broadcastLayerTied;
  broadcastRoomChanged: typeof broadcastRoomChanged;
};

const defaultDeps: AdvanceRoundDeps = {
  advanceLayer,
  finalizeLayer,
  getRoundRoomId,
  broadcastLayerRollsRevealed,
  broadcastRoundRevealed,
  broadcastLayerTied,
  broadcastRoomChanged,
};

export async function advanceRound(
  supabase: SupabaseClient,
  roundId: string,
  event: AdvanceRoundEvent,
  deps: AdvanceRoundDeps = defaultDeps,
): Promise<LayerOutcome> {
  const outcome = await runEntryPoint(supabase, roundId, event, deps);
  const finalization = outcome.outcome === "windowOpened" ? outcome.finalization : outcome;
  const finalized = finalization !== null && finalization.outcome !== "noop";
  const awaitingRevoltPick = outcome.outcome === "noop" && outcome.reason === "revolt_pick_pending";
  if (!outcome.layerRolls && !finalized && !awaitingRevoltPick) return outcome;

  const roomId = await deps.getRoundRoomId(supabase, roundId);

  if (outcome.layerRolls) {
    await deps.broadcastLayerRollsRevealed(supabase, roomId, { roundId, ...outcome.layerRolls });
  }
  if (finalized) {
    await broadcastFinalization(supabase, roomId, roundId, finalization, deps);
  }
  if (awaitingRevoltPick) {
    await deps.broadcastRoomChanged(supabase, roomId);
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
    case "revoltPickMade":
    case "stallCleared":
    case "roundClosed":
    case "lateDeclared":
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
      await deps.broadcastRoomChanged(supabase, roomId);
    }
  } else {
    await deps.broadcastLayerTied(supabase, roomId, {
      roundId,
      layer: finalization.layer,
      tiedPlayerIds: finalization.tiedPlayerIds,
    });
  }
}
