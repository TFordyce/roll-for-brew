import type { SupabaseClient } from "@supabase/supabase-js";
import { hasStalled } from "@/lib/game/stallTimeout";
import { getRoundById, getRoundParticipants } from "@/lib/supabase/rounds";
import {
  cancelRound,
  excludeRoundParticipant,
  forfeitStalledCompelledCasts,
  getCompelledCastStep,
  getCurrentLayerRollerIds,
  getExpectedLayerRollerIds,
  getLayerEnteredAt,
  getLayerZeroWindowClosedAt,
  resolveStalledPendingForcedRerollCasts,
  resolveStalledPendingSpellDice,
  resolveStalledRevoltPicks,
} from "@/lib/supabase/stall";
import { broadcastRoomChanged } from "@/lib/supabase/realtime";
import { advanceRound } from "@/app/rounds/advanceRound";
import {
  closeReactionWindow,
  countEligibleReactionHolders,
  getOpenReactionWindow,
  getReactionSkipVote,
  timeOutReactionWindow,
} from "@/lib/supabase/reactionWindow";

export type StallOutcome =
  | { action: "none" }
  | { action: "cancelled" }
  | { action: "excluded"; playerIds: string[] }
  | { action: "compelledCastsForfeited"; playerIds: string[] }
  | { action: "diceAutoResolved" }
  | { action: "deferredForcedRerollAbandoned" }
  | { action: "revoltPickAbandoned" }
  | { action: "reactionWindowRecovered" }
  | { action: "reactionWindowTimedOut"; playerIds: string[] };

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
    await broadcastRoomChanged(supabase, round.roomId);
    return { action: "cancelled" };
  }

  const layer = round.currentLayer;
  let layerStartedAt: string | null;
  if (layer === 0) {
    const step = await getCompelledCastStep(supabase, roundId);
    if (step.waitingOn.length > 0) {
      if (!round.closedAt || !hasStalled(round.closedAt, nowDate)) return { action: "none" };
      const playerIds = await forfeitStalledCompelledCasts(supabase, roundId);
      await broadcastRoomChanged(supabase, round.roomId);
      await advanceRound(supabase, roundId, "stallCleared");
      return { action: "compelledCastsForfeited", playerIds };
    }
    layerStartedAt = latest(
      step.endedAt ?? round.closedAt,
      await getLayerZeroWindowClosedAt(supabase, roundId),
    );
  } else {
    layerStartedAt = await getLayerEnteredAt(supabase, roundId, layer);
  }
  if (!layerStartedAt || !hasStalled(layerStartedAt, nowDate)) return { action: "none" };

  const expectedPlayerIds = await getExpectedLayerRollerIds(supabase, roundId, layer);

  const rolledPlayerIds = await getCurrentLayerRollerIds(supabase, roundId);
  const stalledPlayerIds = [...expectedPlayerIds].filter((playerId) => !rolledPlayerIds.has(playerId));

  if (stalledPlayerIds.length === 0) {
    if (layer === 0) {
      const resolvedDice = await resolveStalledPendingSpellDice(supabase, roundId);
      const abandonedRerolls = await resolveStalledPendingForcedRerollCasts(supabase, roundId);
      const abandonedPicks = await resolveStalledRevoltPicks(supabase, roundId);
      if (resolvedDice > 0 || abandonedRerolls > 0 || abandonedPicks > 0) {
        await advanceRound(supabase, roundId, "stallCleared");
        if (abandonedPicks > 0) return { action: "revoltPickAbandoned" };
        return abandonedRerolls > 0
          ? { action: "deferredForcedRerollAbandoned" }
          : { action: "diceAutoResolved" };
      }

      const openWindow = await getOpenReactionWindow(supabase, roundId);
      if (openWindow && (await countEligibleReactionHolders(supabase, roundId)) === 0) {
        await closeReactionWindow(supabase, openWindow.windowId);
        await advanceRound(supabase, roundId, "stallCleared");
        return { action: "reactionWindowRecovered" };
      }

      const skipVote = openWindow ? await getReactionSkipVote(supabase, roundId) : null;
      if (skipVote && hasStalled(skipVote.pollRoundStartedAt, nowDate)) {
        const playerIds = await timeOutReactionWindow(supabase, roundId);
        await advanceRound(supabase, roundId, "stallCleared");
        return { action: "reactionWindowTimedOut", playerIds };
      }
    }
    return { action: "none" };
  }

  for (const playerId of stalledPlayerIds) {
    await excludeRoundParticipant(supabase, roundId, playerId, layer);
  }

  if (layer === 0) {
    const participants = await getRoundParticipants(supabase, roundId);
    if (participants.filter((p) => p.excludedAt === null).length < 2) {
      await cancelRound(supabase, roundId);
      await broadcastRoomChanged(supabase, round.roomId);
      return { action: "cancelled" };
    }
  }

  await advanceRound(supabase, roundId, "stallCleared");
  return { action: "excluded", playerIds: stalledPlayerIds };
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}
