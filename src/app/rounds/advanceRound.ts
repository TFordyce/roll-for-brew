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
  broadcastSpellCastChanged,
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
 * - `revoltPickMade`: the lowest roller named who makes tea for a Tea Party
 *   Revolt (issue #430).
 * - `stallCleared`: stall enforcement cleared a blockage (excluded a
 *   non-roller, auto-resolved a Pending Spell Die, abandoned a Deferred
 *   Forced-Reroll Target or a Tea Party Revolt pick, or closed a stranded
 *   window).
 * - `roundClosed`: the round starter closed declarations (issue #432). A
 *   debt round has nobody to roll, so it resolves here; so does a round where
 *   every participant has a Roll Exemption (issue #433), which first opens
 *   its Reaction Window.
 * - `lateDeclared`: a player joined after close (issue #432). A Debtor's Late
 *   Declare before anyone has rolled makes it a debt round, resolved here.
 *
 * Every event except `reactionWindowChanged` routes through advance_layer.
 */
export type AdvanceRoundEvent =
  | "reactionWindowChanged"
  | "layerRolled"
  | "pendingDieResolved"
  | "deferredTargetSet"
  | "revoltPickMade"
  | "stallCleared"
  | "roundClosed"
  | "lateDeclared";

/** The module's one injectable seam: its database entry points plus the broadcasts advancing can cause. */
export type AdvanceRoundDeps = {
  advanceLayer: typeof advanceLayer;
  finalizeLayer: typeof finalizeLayer;
  getRoundRoomId: typeof getRoundRoomId;
  broadcastLayerRollsRevealed: typeof broadcastLayerRollsRevealed;
  broadcastRoundRevealed: typeof broadcastRoundRevealed;
  broadcastLayerTied: typeof broadcastLayerTied;
  broadcastRoundReplayChanged: typeof broadcastRoundReplayChanged;
  broadcastSpellCastChanged: typeof broadcastSpellCastChanged;
};

const defaultDeps: AdvanceRoundDeps = {
  advanceLayer,
  finalizeLayer,
  getRoundRoomId,
  broadcastLayerRollsRevealed,
  broadcastRoundRevealed,
  broadcastLayerTied,
  broadcastRoundReplayChanged,
  broadcastSpellCastChanged,
};

/**
 * The Round-advancement module (ADR 0008): a caller does its own write,
 * broadcasts it and revalidates, and raises the event here. This runs the
 * database step the event allows and sends every broadcast the outcome causes
 * — layer rolls revealed when this call first found the Layer complete, then
 * round revealed (plus round replay changed when a replay is now pending) for
 * a brewer, layer tied for a tie, nothing for a noop or a window left open —
 * except a Layer held for a Tea Party Revolt pick (issue #430), which sends a
 * spell-cast change so the lowest roller's page shows the pick prompt.
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
    await deps.broadcastSpellCastChanged(supabase, roomId, { roundId });
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
