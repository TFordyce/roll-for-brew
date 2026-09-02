import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundRoomId } from "@/lib/supabase/rounds";
import {
  advanceRoundLayer,
  getCurrentLayerRollsIfComplete,
  resolveRound,
  resolveRoundOutcome,
  type CompletedLayer,
} from "@/lib/supabase/rolls";
import {
  broadcastLayerRollsRevealed,
  broadcastLayerTied,
  broadcastRoundReplayChanged,
  broadcastRoundRevealed,
} from "@/lib/supabase/realtime";
import { recordPendingRoundReplay } from "@/lib/supabase/roundReplay";
import {
  applyForcedReroll,
  applyRollFlip,
  applyRollPairTransform,
  applyRollSwap,
  getForcedRerollTargets,
  hasActiveCastKind,
  openReactionWindow,
  resolveDeclaredNumberTeaMaker,
} from "@/lib/supabase/reactionWindow";

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
  hasActiveCastKind: typeof hasActiveCastKind;
  applyRollFlip: typeof applyRollFlip;
  applyRollSwap: typeof applyRollSwap;
  applyRollPairTransform: typeof applyRollPairTransform;
  applyLayerOutcome: typeof applyLayerOutcome;
};

const defaultFinalizeDeps: FinalizeReactionWindowDeps = {
  getCurrentLayerRollsIfComplete,
  getForcedRerollTargets,
  applyForcedReroll,
  hasActiveCastKind,
  applyRollFlip,
  applyRollSwap,
  applyRollPairTransform,
  applyLayerOutcome,
};

/**
 * Runs once a layer's reaction window has closed (every eligible Reaction-
 * card holder passed in the same poll round, or nobody was eligible to begin
 * with): applies any still-active forced_reroll effects in place on the
 * layer's own rolls (Double Dunk, Milk First?, ...), then the remaining
 * roll-transform effects (0033: Zariel's Fall/roll_flip, Dunkin
 * Disaster/roll_swap; 0094: the chosen-pair transforms/roll_pair_transform),
 * in that fixed order — "flip before swap before chosen-pair", the documented
 * tie of record for a player hit by more than one. Each apply_* RPC now
 * also records its exact before→after into spell_casts.cast_inputs
 * (migration 0079, issue #306); resolve_round rebuilds every roller's final
 * roll from those recorded values, so the in-memory `rolls` patching below
 * only feeds the reveal broadcast, not the outcome. Hands off to
 * applyLayerOutcome, which calls the authoritative resolve_round. Broken
 * Biscuit/lowest_gains_highest_modifier is no longer applied here: it moved
 * into resolve_round as pure modifier math on the composed modifiers, so it
 * lifts the composed modifier rather than mutating a roll value (issue #305).
 * Distinct from the tie-break mechanism, which spawns a new layer instead of
 * mutating the current one (issue #68's AC). A negated cast never reaches
 * here: get_forced_reroll_targets/has_active_cast_kind already exclude one.
 */
export async function finalizeReactionWindow(
  supabase: SupabaseClient,
  roundId: string,
  deps: FinalizeReactionWindowDeps = defaultFinalizeDeps,
): Promise<void> {
  const completedLayer = await deps.getCurrentLayerRollsIfComplete(supabase, roundId);
  if (!completedLayer) return;

  const { layer } = completedLayer;
  const forcedRerollTargets = await deps.getForcedRerollTargets(supabase, roundId, layer);

  let rolls = completedLayer.rolls;
  for (const playerId of forcedRerollTargets) {
    const newValue = await deps.applyForcedReroll(supabase, roundId, layer, playerId);
    rolls = rolls.map((r) => (r.playerId === playerId ? { ...r, value: newValue } : r));
  }

  const applyChanges = (changes: { playerId: string; value: number }[]) => {
    for (const change of changes) {
      rolls = rolls.map((r) => (r.playerId === change.playerId ? { ...r, value: change.value } : r));
    }
  };

  if (await deps.hasActiveCastKind(supabase, roundId, layer, "roll_flip")) {
    applyChanges(await deps.applyRollFlip(supabase, roundId, layer));
  }
  if (await deps.hasActiveCastKind(supabase, roundId, layer, "roll_swap")) {
    applyChanges(await deps.applyRollSwap(supabase, roundId, layer));
  }
  // Issue #318: chosen-pair roll transform (Brew-tal Swap / Stir the Pot /
  // Steaming Mug Bond / Tea for Two) — order 5, after the automatic
  // highest↔lowest roll_swap.
  if (await deps.hasActiveCastKind(supabase, roundId, layer, "roll_pair_transform")) {
    applyChanges(await deps.applyRollPairTransform(supabase, roundId, layer));
  }

  await deps.applyLayerOutcome(supabase, roundId, { ...completedLayer, rolls });
}

/**
 * resolveCompletedLayerIfAny's dependency seam, same injectable-deps pattern
 * as ApplyLayerOutcomeDeps/FinalizeReactionWindowDeps above — production
 * callers get defaultResolveCompletedLayerDeps,
 * resolveCompletedLayerIfAny.test.ts passes fakes.
 */
export type ResolveCompletedLayerDeps = {
  getCurrentLayerRollsIfComplete: typeof getCurrentLayerRollsIfComplete;
  getRoundRoomId: typeof getRoundRoomId;
  broadcastLayerRollsRevealed: typeof broadcastLayerRollsRevealed;
  openReactionWindow: typeof openReactionWindow;
  finalizeReactionWindow: typeof finalizeReactionWindow;
};

const defaultResolveCompletedLayerDeps: ResolveCompletedLayerDeps = {
  getCurrentLayerRollsIfComplete,
  getRoundRoomId,
  broadcastLayerRollsRevealed,
  openReactionWindow,
  finalizeReactionWindow,
};

/**
 * If the round's current layer is complete (get_current_layer_rolls_if_complete
 * returns rows), broadcasts its raw rolls, then:
 *
 * - Layer 0 (the original roll): opens a reaction window for it (issue #68),
 *   and — only if nobody is currently eligible to react, so the window
 *   closes itself immediately — finalizes it in the same request. Otherwise
 *   finalization waits for whichever later action (a reaction cast or a
 *   pass) closes the window; see passReactionWindowAction
 *   (src/app/rounds/actions.ts).
 * - Any tie-break reroll layer (layer > 0): no reaction window is ever
 *   opened — a reaction spell cannot be cast against a tie-break reroll —
 *   and the layer finalizes immediately (issue #219).
 *
 * Used by submitRollAction and submitManualRollAction (#22) — either way,
 * the caller (the player who just rolled) is always themselves an expected
 * roller of the layer they just completed, so the RPCs' caller-identity
 * gates never get in the way here.
 */
export async function resolveCompletedLayerIfAny(
  supabase: SupabaseClient,
  roundId: string,
  deps: ResolveCompletedLayerDeps = defaultResolveCompletedLayerDeps,
): Promise<void> {
  const completedLayer = await deps.getCurrentLayerRollsIfComplete(supabase, roundId);
  if (!completedLayer) return;

  const roomId = await deps.getRoundRoomId(supabase, roundId);
  await deps.broadcastLayerRollsRevealed(supabase, roomId, {
    roundId,
    layer: completedLayer.layer,
    rolls: completedLayer.rolls.map((r) => ({
      playerId: r.playerId,
      value: r.value,
      discardedValue: r.discardedValue,
      enteredByAdmin: r.enteredByAdmin,
    })),
  });

  if (completedLayer.layer === 0) {
    const { isClosed } = await deps.openReactionWindow(supabase, roundId, completedLayer.layer);
    if (isClosed) {
      await deps.finalizeReactionWindow(supabase, roundId);
    }
  } else {
    await deps.finalizeReactionWindow(supabase, roundId);
  }
}
