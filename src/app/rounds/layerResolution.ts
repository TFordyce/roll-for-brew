import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundParticipants, getRoundRoomId } from "@/lib/supabase/rounds";
import { advanceRoundLayer, getCurrentLayerRollsIfComplete, resolveRound, type CompletedLayer } from "@/lib/supabase/rolls";
import { broadcastLayerRollsRevealed, broadcastLayerTied, broadcastRoundRevealed } from "@/lib/supabase/realtime";
import { getRoundModifierEffects } from "@/lib/supabase/spellCasts";
import {
  applyForcedReroll,
  applyLowestGainsHighestModifier,
  applyRollFlip,
  applyRollSwap,
  getForcedRerollTargets,
  getTeaMakerOverride,
  hasActiveCastKind,
  openReactionWindow,
  resolveDeclaredNumberTeaMaker,
} from "@/lib/supabase/reactionWindow";
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
  getTeaMakerOverride: typeof getTeaMakerOverride;
  resolveDeclaredNumberTeaMaker: typeof resolveDeclaredNumberTeaMaker;
  resolveRound: typeof resolveRound;
  advanceRoundLayer: typeof advanceRoundLayer;
  broadcastRoundRevealed: typeof broadcastRoundRevealed;
  broadcastLayerTied: typeof broadcastLayerTied;
};

const defaultDeps: ApplyLayerOutcomeDeps = {
  getRoundRoomId,
  getRoundParticipants,
  getRoundModifierEffects,
  getTeaMakerOverride,
  resolveDeclaredNumberTeaMaker,
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
  const { rolls, layer } = completedLayer;

  // Inscribed Saucer/tea_maker_override (0033) decide the brewer by a rule
  // other than "lowest roll+modifier wins" — checked before resolveLayer
  // runs at all, "regardless of totals"/"instead of the lowest" per their
  // card text. Declared-number takes precedence (it's a one-time, whole-round
  // override); a 'chosen' override still awaiting its target (Wild Brew
  // Surge branch 6, caster hasn't picked yet) is left for a later attempt —
  // this layer resolves normally in the meantime rather than blocking.
  const declaredNumberBrewer = await deps.resolveDeclaredNumberTeaMaker(supabase, roundId, layer);
  const override = declaredNumberBrewer ? null : await deps.getTeaMakerOverride(supabase, roundId);

  let brewerId: string | null = declaredNumberBrewer;
  let noModifierGain = false;

  if (!brewerId && override && !override.targetPending) {
    if (override.mode === "chosen") {
      brewerId = override.chosenPlayerId;
    } else if (override.mode === "highest_roll") {
      brewerId = [...rolls].sort((a, b) => b.value - a.value)[0]?.playerId ?? null;
    } else {
      brewerId = [...rolls].sort((a, b) => b.modifierSnapshot - a.modifierSnapshot)[0]?.playerId ?? null;
    }
    noModifierGain = override.noModifierGain;
  }

  const effectsByPlayer = await deps.getRoundModifierEffects(supabase, roundId);
  const outcome = brewerId
    ? ({ outcome: "brewer", playerId: brewerId } as const)
    : resolveLayer(
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

    // Only passed when true, so an ordinary brewing round's resolveRound
    // call keeps its original 4-arg shape (existing tests assert on it
    // exactly) — noModifierGain only ever comes from a tea_maker_override
    // cast (Drip Tray).
    if (noModifierGain) {
      await deps.resolveRound(supabase, roundId, outcome.playerId, cupsMade, true);
    } else {
      await deps.resolveRound(supabase, roundId, outcome.playerId, cupsMade);
    }

    await deps.broadcastRoundRevealed(supabase, roomId, {
      roundId,
      brewerId: outcome.playerId,
      cupsMade,
      rolls: rolls.map((r) => ({ playerId: r.playerId, value: r.value, discardedValue: r.discardedValue })),
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
  hasActiveCastKind: typeof hasActiveCastKind;
  applyRollFlip: typeof applyRollFlip;
  applyRollSwap: typeof applyRollSwap;
  applyLowestGainsHighestModifier: typeof applyLowestGainsHighestModifier;
  applyLayerOutcome: typeof applyLayerOutcome;
};

const defaultFinalizeDeps: FinalizeReactionWindowDeps = {
  getCurrentLayerRollsIfComplete,
  getForcedRerollTargets,
  applyForcedReroll,
  hasActiveCastKind,
  applyRollFlip,
  applyRollSwap,
  applyLowestGainsHighestModifier,
  applyLayerOutcome,
};

/**
 * Runs once a layer's reaction window has closed (every eligible Reaction-
 * card holder passed in the same poll round, or nobody was eligible to begin
 * with): applies any still-active forced_reroll effects in place on the
 * layer's own rolls (Double Dunk, Milk First?, ...), then any of the three
 * table-wide roll-transform effects (0033: Zariel's Fall/roll_flip, Dunkin
 * Disaster/roll_swap, Broken Biscuit/lowest_gains_highest_modifier), in that
 * fixed order — a deliberate simplification for the rare case of more than
 * one landing on the same layer, rather than trying to reason about card-text
 * precedence between them — and re-runs resolveLayer against the updated
 * entries via applyLayerOutcome. Distinct from the tie-break mechanism, which
 * spawns a new layer instead of mutating the current one (issue #68's AC). A
 * negated cast never reaches here: get_forced_reroll_targets/
 * has_active_cast_kind already exclude one.
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
  if (await deps.hasActiveCastKind(supabase, roundId, layer, "lowest_gains_highest_modifier")) {
    applyChanges(await deps.applyLowestGainsHighestModifier(supabase, roundId, layer));
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
    rolls: completedLayer.rolls.map((r) => ({
      playerId: r.playerId,
      value: r.value,
      discardedValue: r.discardedValue,
    })),
  });

  const { isClosed } = await openReactionWindow(supabase, roundId, completedLayer.layer);
  if (isClosed) {
    await finalizeReactionWindow(supabase, roundId);
  }
}
