import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundParticipants, getRoundRoomId } from "@/lib/supabase/rounds";
import { advanceRoundLayer, getCurrentLayerRollsIfComplete, resolveRound, type CompletedLayer } from "@/lib/supabase/rolls";
import { broadcastLayerTied, broadcastRoundRevealed } from "@/lib/supabase/realtime";
import { getRoundModifierEffects } from "@/lib/supabase/spellCasts";
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
 * If the round's current layer is complete (get_current_layer_rolls_if_complete
 * returns rows), applies its outcome. Used by submitRollAction and
 * submitManualRollAction (#22) — either way, the caller (the player who just
 * rolled) is always themselves an expected roller of the layer they just
 * completed, so the RPC's caller-identity gate never gets in the way here.
 */
export async function resolveCompletedLayerIfAny(
  supabase: SupabaseClient,
  roundId: string,
): Promise<void> {
  const completedLayer = await getCurrentLayerRollsIfComplete(supabase, roundId);
  if (!completedLayer) return;
  await applyLayerOutcome(supabase, roundId, completedLayer);
}
