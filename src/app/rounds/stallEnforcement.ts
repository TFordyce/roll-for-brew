import type { SupabaseClient } from "@supabase/supabase-js";
import { hasStalled } from "@/lib/game/stallTimeout";
import { getRoundById, getRoundLayerParticipants, getRoundParticipants } from "@/lib/supabase/rounds";
import {
  cancelRound,
  excludeRoundParticipant,
  getCompletedLayerRollsForStallResolution,
  getCurrentLayerRollerIds,
  getLayerEnteredAt,
} from "@/lib/supabase/stall";
import { broadcastRoundCancelled } from "@/lib/supabase/realtime";
import { applyLayerOutcome } from "@/app/rounds/layerResolution";

export type StallOutcome =
  | { action: "none" }
  | { action: "cancelled" }
  | { action: "excluded"; playerIds: string[] };

/**
 * Lazy check-on-read stall-timeout enforcement (issue #21): called from
 * src/app/page.tsx on every render of a room with an active round, rather
 * than a scheduled job — there's no cron/worker anywhere in this app, and a
 * fresh Supabase read already happens on every request there. `now` is
 * injectable so tests can simulate ~2 minutes elapsing without sleeping it
 * out for real.
 *
 * Three stall points, one per round phase:
 *  - status 'open': the starter never closed declarations -> cancel.
 *  - status 'closed', layer 0: a declared player never rolled -> exclude
 *    them and let the remaining participants' resolution proceed.
 *  - status 'closed', layer > 0: a tied player never submitted their
 *    reroll -> exclude them from that layer and let the remaining tied
 *    players' resolution proceed.
 * Any exclusion that drops the layer's active (non-excluded) participant
 * count below 2 cancels the round outright instead of resolving it.
 */
export async function enforceStallTimeout(
  supabase: SupabaseClient,
  roundId: string,
  now: () => Date = () => new Date(),
): Promise<StallOutcome> {
  const round = await getRoundById(supabase, roundId);
  if (!round || (round.status !== "open" && round.status !== "closed")) {
    return { action: "none" };
  }

  const nowDate = now();

  if (round.status === "open") {
    if (!hasStalled(round.startedAt, nowDate)) return { action: "none" };
    await cancelRound(supabase, roundId);
    await broadcastRoundCancelled(supabase, round.roomId, { roundId });
    return { action: "cancelled" };
  }

  const layer = round.currentLayer;
  const layerStartedAt = layer === 0 ? round.closedAt : await getLayerEnteredAt(supabase, roundId, layer);
  if (!layerStartedAt || !hasStalled(layerStartedAt, nowDate)) return { action: "none" };

  const expected =
    layer === 0
      ? await getRoundParticipants(supabase, roundId)
      : await getRoundLayerParticipants(supabase, roundId, layer);
  const active = expected.filter((p) => !p.excludedAt);

  const rolledPlayerIds = await getCurrentLayerRollerIds(supabase, roundId);
  const stalledPlayerIds = active
    .map((p) => p.playerId)
    .filter((playerId) => !rolledPlayerIds.has(playerId));

  if (stalledPlayerIds.length === 0) return { action: "none" };

  for (const playerId of stalledPlayerIds) {
    await excludeRoundParticipant(supabase, roundId, playerId, layer);
  }

  const remainingActiveCount = active.length - stalledPlayerIds.length;
  if (remainingActiveCount < 2) {
    await cancelRound(supabase, roundId);
    await broadcastRoundCancelled(supabase, round.roomId, { roundId });
    return { action: "cancelled" };
  }

  const completedLayer = await getCompletedLayerRollsForStallResolution(supabase, roundId);
  if (completedLayer) {
    await applyLayerOutcome(supabase, roundId, completedLayer);
  }
  return { action: "excluded", playerIds: stalledPlayerIds };
}
