import type { SupabaseClient } from "@supabase/supabase-js";
import { getRoundParticipants, getRoundRoomId } from "@/lib/supabase/rounds";
import { advanceRoundLayer, getCurrentLayerRollsIfComplete, resolveRound, type CompletedLayer } from "@/lib/supabase/rolls";
import { broadcastLayerTied, broadcastRoundRevealed } from "@/lib/supabase/realtime";
import { resolveLayer } from "@/lib/game/resolveLayer";

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
): Promise<void> {
  const { rolls } = completedLayer;
  const outcome = resolveLayer(
    rolls.map((r) => ({ playerId: r.playerId, roll: r.value, modifier: r.modifierSnapshot })),
  );

  const roomId = await getRoundRoomId(supabase, roundId);

  if (outcome.outcome === "brewer") {
    // cups_made is the number of cups the brewer owes everyone who played
    // this round — the round's original participant count, not the
    // (possibly much narrower) tied subset that rolled the final layer.
    const participants = await getRoundParticipants(supabase, roundId);
    const cupsMade = participants.length;

    await resolveRound(supabase, roundId, outcome.playerId, cupsMade);

    await broadcastRoundRevealed(supabase, roomId, {
      roundId,
      brewerId: outcome.playerId,
      cupsMade,
      rolls: rolls.map((r) => ({ playerId: r.playerId, value: r.value })),
    });
  } else {
    const nextLayer = await advanceRoundLayer(supabase, roundId, outcome.tiedPlayerIds);

    await broadcastLayerTied(supabase, roomId, {
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
