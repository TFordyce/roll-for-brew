import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundParticipants, getRoundRoomId } from "@/lib/supabase/rounds";
import { advanceRoundLayer, getCurrentLayerRollsIfComplete, resolveRound, type CompletedLayer } from "@/lib/supabase/rolls";
import { broadcastLayerRollsRevealed, broadcastLayerTied, broadcastRoundRevealed } from "@/lib/supabase/realtime";
import { getRoundModifierEffects } from "@/lib/supabase/spellCasts";
import { applyForcedReroll, getForcedRerollTargets, openReactionWindow } from "@/lib/supabase/reactionWindow";
import { resolveLayer } from "@/lib/game/resolveLayer";
import { composeModifier } from "@/lib/game/modifierBucket";

/**
 * applyLayerOutcome's persistence/broadcast calls, factored out as an
 * injectable seam: production callers get defaultDeps (the real
 * supabase-backed functions below), while applyLayerOutcome.test.ts passes
 * fakes so it can assert on the brewer/tie branches without a live Supabase
 * client.
 */
export type ApplyLayerOutcomeDeps = {
  getRoundRoomId: typeof getRoundRoomId;
  getRoundParticipants: typeof getRoundParticipants;
  getRoundModifierEffects: typeof getRoundModifierEffects;
  resolveRound: typeof resolveRound;
  advanceRoundLayer: typeof advanceRoundLayer;
  broadcastRoundRevealed: typeof broadcastRoundRevealed;
  broadcastLayerTied: typeof broadcastLayerTied;
};

const defaultDeps: ApplyLayerOutcomeDeps = {
  getRoundRoomId,
  getRoundParticipants,
  getRoundModifierEffects,
  resolveRound,
  advanceRoundLayer,
  broadcastRoundRevealed,
  broadcastLayerTied,
};

/**
 * Runs the resolution engine over a layer that's already known to be
 * complete and persists/broadcasts whichever outcome it computes — a single
 * brewer, or the next reroll layer. Split out from the "is it complete"
 * fetch so callers can use whichever completeness-check RPC fits their
 * caller's permissions (see resolveCompletedLayerIfAny below vs
 * stallEnforcement.ts's use of getCompletedLayerRollsForStallResolution).
 */
export async function applyLayerOutcome(
  supabase: SupabaseClient,
  roundId: string,
  completedLayer: CompletedLayer,
  deps: ApplyLayerOutcomeDeps = defaultDeps,
): Promise<void> {
  const { rolls } = completedLayer;
  const effectsByPlayer = await deps.getRoundModifierEffects(supabase, roundId);
  const outcome = resolveLayer(
    rolls.map((r) => ({
      playerId: r.playerId,
      roll: r.value,
      modifier: composeModifier(r.modifierSnapshot, effectsByPlayer.get(r.playerId) ?? []),
    })),
  );

  const roomId = await deps.getRoundRoomId(supabase, roundId);

  if (outcome.outcome === "brewer") {
    // cups_made is the number of cups the brewer owes everyone who played
    // this round — the round's original participant count, not the
    // (possibly much narrower) tied subset that rolled the final layer.
    const participants = await deps.getRoundParticipants(supabase, roundId);
    const cupsMade = participants.length;

    await deps.resolveRound(supabase, roundId, outcome.playerId, cupsMade);

    await deps.broadcastRoundRevealed(supabase, roomId, {
      roundId,
      brewerId: outcome.playerId,
      cupsMade,
      rolls: rolls.map((r) => ({ playerId: r.playerId, value: r.value })),
    });
  } else {
    const nextLayer = await deps.advanceRoundLayer(supabase, roundId, outcome.tiedPlayerIds);

    await deps.broadcastLayerTied(supabase, roomId, {
      roundId,
      layer: nextLayer,
      tiedPlayerIds: outcome.tiedPlayerIds,
    });
  }
}

/**
 * finalizeReactionWindow's dependency seam, same injectable-deps pattern as
 * ApplyLayerOutcomeDeps above — production callers get defaultFinalizeDeps,
 * finalizeReactionWindow.test.ts (mirrors the style of layerResolution.test.ts)
 * passes fakes.
 */
export type FinalizeReactionWindowDeps = {
  getCurrentLayerRollsIfComplete: typeof getCurrentLayerRollsIfComplete;
  getForcedRerollTargets: typeof getForcedRerollTargets;
  applyForcedReroll: typeof applyForcedReroll;
  applyLayerOutcome: typeof applyLayerOutcome;
};

const defaultFinalizeDeps: FinalizeReactionWindowDeps = {
  getCurrentLayerRollsIfComplete,
  getForcedRerollTargets,
  applyForcedReroll,
  applyLayerOutcome,
};

/**
 * Runs once a layer's reaction window has closed (every eligible Reaction-
 * card holder passed in the same poll round, or nobody was eligible to begin
 * with): applies any still-active forced_reroll effects in place on the
 * layer's own rolls (Double Dunk, Milk First?, ...) and re-runs resolveLayer
 * against the updated entries via applyLayerOutcome — distinct from the
 * tie-break mechanism, which spawns a new layer instead of mutating the
 * current one (issue #68's AC). A negated forced_reroll (a successful
 * contested_negate reaction against it) never reaches here:
 * get_forced_reroll_targets already excludes it.
 */
export async function finalizeReactionWindow(
  supabase: SupabaseClient,
  roundId: string,
  deps: FinalizeReactionWindowDeps = defaultFinalizeDeps,
): Promise<void> {
  const completedLayer = await deps.getCurrentLayerRollsIfComplete(supabase, roundId);
  if (!completedLayer) return;

  const forcedRerollTargets = await deps.getForcedRerollTargets(supabase, roundId, completedLayer.layer);

  let rolls = completedLayer.rolls;
  for (const playerId of forcedRerollTargets) {
    const newValue = await deps.applyForcedReroll(supabase, roundId, completedLayer.layer, playerId);
    rolls = rolls.map((r) => (r.playerId === playerId ? { ...r, value: newValue } : r));
  }

  await deps.applyLayerOutcome(supabase, roundId, { ...completedLayer, rolls });
}

/**
 * If the round's current layer is complete (get_current_layer_rolls_if_complete
 * returns rows), broadcasts its raw rolls, opens a reaction window for it
 * (issue #68), and — only if nobody is currently eligible to react, so the
 * window closes itself immediately — finalizes it in the same request.
 * Otherwise finalization waits for whichever later action (a reaction cast
 * or a pass) closes the window; see passReactionWindowAction
 * (src/app/rounds/actions.ts).
 *
 * Used by submitRollAction and submitManualRollAction (#22) — either way,
 * the caller (the player who just rolled) is always themselves an expected
 * roller of the layer they just completed, so the RPCs' caller-identity
 * gates never get in the way here.
 */
export async function resolveCompletedLayerIfAny(
  supabase: SupabaseClient,
  roundId: string,
): Promise<void> {
  const completedLayer = await getCurrentLayerRollsIfComplete(supabase, roundId);
  if (!completedLayer) return;

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastLayerRollsRevealed(supabase, roomId, {
    roundId,
    layer: completedLayer.layer,
    rolls: completedLayer.rolls.map((r) => ({ playerId: r.playerId, value: r.value })),
  });

  const { isClosed } = await openReactionWindow(supabase, roundId, completedLayer.layer);
  if (isClosed) {
    await finalizeReactionWindow(supabase, roundId);
  }
}
