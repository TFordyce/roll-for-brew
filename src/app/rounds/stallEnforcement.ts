import type { SupabaseClient } from "@supabase/supabase-js";
import { hasStalled } from "@/lib/game/stallTimeout";
import { getRoundById } from "@/lib/supabase/rounds";
import {
  cancelRound,
  excludeRoundParticipant,
  getCompletedLayerRollsForStallResolution,
  getCurrentLayerRollerIds,
  getExpectedLayerRollerIds,
  getLayerEnteredAt,
  resolveStalledPendingForcedRerollCasts,
  resolveStalledPendingSpellDice,
} from "@/lib/supabase/stall";
import { broadcastRoundCancelled } from "@/lib/supabase/realtime";
import { applyLayerOutcome } from "@/app/rounds/layerResolution";

export type StallOutcome =
  | { action: "none" }
  | { action: "cancelled" }
  | { action: "excluded"; playerIds: string[] }
  | { action: "diceAutoResolved" }
  | { action: "deferredForcedRerollAbandoned" };

/**
 * Lazy check-on-read stall-timeout enforcement (issue #21): called from
 * src/app/page.tsx on every render of a room with an active round, rather
 * than a scheduled job — there's no cron/worker anywhere in this app, and a
 * fresh Supabase read already happens on every request there. `now` is
 * injectable so tests can simulate ~5 minutes elapsing without sleeping it
 * out for real.
 *
 * Four stall points, one per round phase:
 *  - status 'open': the starter never closed declarations -> cancel.
 *  - status 'closed', layer 0: a declared player never rolled -> exclude
 *    them and let the remaining participants' resolution proceed.
 *  - status 'closed', layer > 0: a tied player never submitted their
 *    reroll -> exclude them from that layer and let the remaining tied
 *    players' resolution proceed.
 *  - status 'closed', layer 0, every expected roller already rolled but a
 *    Pending Spell Die (issue #252, e.g. Cold Tea/Slipped Spoon's caster)
 *    is still unresolved, or a pre-roll forced_reroll cast (issue #325,
 *    Yorkshire Terror) is still awaiting its deferred target -> auto-resolve
 *    / force-negate it and let resolution proceed. Not a fourth independent
 *    clock — it's this same 5-minute-since-closed timer catching stall
 *    shapes the "did they roll" check above can't see (the caster already
 *    rolled; they just never gave their die a value, or never named their
 *    reroll's target). In practice the pending-die case is the recovery path
 *    for a *pre-roll* pending die (Cold Tea/Slipped Spoon) — a Reaction-
 *    timed one (Six Sugars) is usually already resolved by the time its
 *    still-open reaction window would otherwise leave this same query
 *    blocked, but resolving it here too if it somehow isn't is harmless:
 *    applyLayerOutcome below is exactly what the ordinary (non-stalled)
 *    reaction-window-closes path already calls too, just via
 *    finalizeReactionWindow instead of directly.
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

  const expectedPlayerIds = await getExpectedLayerRollerIds(supabase, roundId, layer);

  const rolledPlayerIds = await getCurrentLayerRollerIds(supabase, roundId);
  const stalledPlayerIds = [...expectedPlayerIds].filter((playerId) => !rolledPlayerIds.has(playerId));

  if (stalledPlayerIds.length === 0) {
    // Every expected roller has rolled, yet get_current_layer_rolls_if_complete
    // (migration 0069) still won't treat layer 0 as complete when a Pending
    // Spell Die is outstanding — the exclude-a-non-roller logic below has
    // nothing to do here, so this is the recovery path for that shape
    // instead (see this function's own doc comment above).
    if (layer === 0) {
      // Two shapes the "did they roll" check above can't see, both cleared
      // by this same 5-minute timer: a Pending Spell Die never given a value
      // (issue #252), and a pre-roll forced_reroll cast whose caster never
      // named its deferred target (issue #325). Recover whichever is
      // outstanding, then let resolution proceed.
      const resolvedDice = await resolveStalledPendingSpellDice(supabase, roundId);
      const abandonedRerolls = await resolveStalledPendingForcedRerollCasts(supabase, roundId);
      if (resolvedDice > 0 || abandonedRerolls > 0) {
        const completedLayer = await getCompletedLayerRollsForStallResolution(supabase, roundId);
        if (completedLayer) {
          await applyLayerOutcome(supabase, roundId, completedLayer);
        }
        return abandonedRerolls > 0
          ? { action: "deferredForcedRerollAbandoned" }
          : { action: "diceAutoResolved" };
      }
    }
    return { action: "none" };
  }

  for (const playerId of stalledPlayerIds) {
    await excludeRoundParticipant(supabase, roundId, playerId, layer);
  }

  // Layer 0 needs at least 2 active participants to resolve a round at all
  // (mirrors close_round's own >=2 gate). A reroll layer (layer > 0) is
  // already a tied subset of those same participants, so shrinking it to a
  // single remaining roller isn't a failure to resolve — resolveLayer
  // treats that lone roller as the outright winner of the tie, same as if
  // everyone else had simply lost the reroll outright.
  const remainingActiveCount = expectedPlayerIds.size - stalledPlayerIds.length;
  if (layer === 0 && remainingActiveCount < 2) {
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
