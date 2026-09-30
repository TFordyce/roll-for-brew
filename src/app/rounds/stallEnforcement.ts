import type { SupabaseClient } from "@supabase/supabase-js";
import { hasStalled } from "@/lib/game/stallTimeout";
import { getRoundById } from "@/lib/supabase/rounds";
import {
  cancelRound,
  excludeRoundParticipant,
  getCurrentLayerRollerIds,
  getExpectedLayerRollerIds,
  getLayerEnteredAt,
  resolveStalledPendingForcedRerollCasts,
  resolveStalledPendingSpellDice,
} from "@/lib/supabase/stall";
import { broadcastRoundCancelled } from "@/lib/supabase/realtime";
import { advanceRound } from "@/app/rounds/advanceRound";
import { closeReactionWindow, countEligibleReactionHolders, getOpenReactionWindow } from "@/lib/supabase/reactionWindow";

export type StallOutcome =
  | { action: "none" }
  | { action: "cancelled" }
  | { action: "excluded"; playerIds: string[] }
  | { action: "diceAutoResolved" }
  | { action: "deferredForcedRerollAbandoned" }
  | { action: "reactionWindowRecovered" };

/**
 * Lazy check-on-read stall-timeout enforcement (issue #21): called from
 * src/app/page.tsx on every render of a room with an active round, rather
 * than a scheduled job — there's no cron/worker anywhere in this app, and a
 * fresh Supabase read already happens on every request there. `now` is
 * injectable so tests can simulate ~5 minutes elapsing without sleeping it
 * out for real.
 *
 * Stall only clears blockages (ADR 0008, issue #416): it cancels, excludes,
 * auto-resolves or abandons, then raises advanceRound(stallCleared) like any
 * other caller — so a stall-cleared Layer 0 gets its reaction window and roll
 * transforms exactly as an ordinary round would, and nothing here runs a
 * resolution step directly. Advancement never checks who the caller is, so
 * this is safe on a spectator's render.
 *
 * Stall points, by round phase:
 *  - status 'open': the starter never closed declarations -> cancel.
 *  - status 'closed', layer 0: a declared player never rolled -> exclude
 *    them; the remaining participants' Layer is then complete.
 *  - status 'closed', layer > 0: a tied player never submitted their
 *    reroll -> exclude them from that layer; the remaining tied players'
 *    Layer is then complete.
 *  - status 'closed', layer 0, every expected roller already rolled but a
 *    Pending Spell Die (issue #252, e.g. Cold Tea/Slipped Spoon's caster)
 *    is still unresolved, or a pre-roll forced_reroll cast (issue #325,
 *    Yorkshire Terror) is still awaiting its deferred target -> auto-resolve
 *    / force-negate it. Not an independent clock — it's this same
 *    5-minute-since-closed timer catching stall shapes the "did they roll"
 *    check above can't see (the caster already rolled; they just never gave
 *    their die a value, or never named their reroll's target). In practice
 *    the pending-die case is the recovery path for a *pre-roll* pending die
 *    (Cold Tea/Slipped Spoon) — a Reaction-timed one (Six Sugars) is usually
 *    already resolved by the time its still-open reaction window would
 *    otherwise leave this same query blocked, but resolving it here too if
 *    it somehow isn't is harmless: advance_layer leaves an open window open.
 *  - status 'closed', layer 0, every expected roller already rolled but the
 *    layer's reaction window is still status = 'open' with zero eligible
 *    Reaction-card holders (issue #387) -> close the window. Same 5-minute
 *    clock again; recovers a window a pre-0104 cast_reaction_spell_card
 *    stranded (the cast reopened the poll but left nobody able to Pass),
 *    which migration 0104 prevents going forward.
 * Any exclusion that drops the layer's active (non-excluded) participant
 * count below 2 cancels the round outright instead; a cancel raises no event.
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
    // Every expected roller has rolled, yet the Layer can still be held
    // incomplete by a Pending Spell Die or a Deferred Forced-Reroll Target —
    // the exclude-a-non-roller logic below has nothing to do here, so this is
    // the recovery path for those shapes instead (see the doc comment above).
    if (layer === 0) {
      // Two shapes the "did they roll" check above can't see, both cleared
      // by this same 5-minute timer: a Pending Spell Die never given a value
      // (issue #252), and a pre-roll forced_reroll cast whose caster never
      // named its deferred target (issue #325). Clear whichever is
      // outstanding; advance_layer then opens the reaction window (or
      // finalizes, if nobody can react) as it would for any complete Layer.
      const resolvedDice = await resolveStalledPendingSpellDice(supabase, roundId);
      const abandonedRerolls = await resolveStalledPendingForcedRerollCasts(supabase, roundId);
      if (resolvedDice > 0 || abandonedRerolls > 0) {
        await advanceRound(supabase, roundId, "stallCleared");
        // Both shapes can be outstanding on one round; the outcome is a
        // single label for page.tsx's "did anything happen" check, so report
        // the rarer forced_reroll recovery when it fired.
        return abandonedRerolls > 0
          ? { action: "deferredForcedRerollAbandoned" }
          : { action: "diceAutoResolved" };
      }

      // A reaction window left status = 'open' with zero eligible Reaction-
      // card holders (issue #387): casting the last held Reaction card
      // reopened the chaining poll (0068) but left nobody able to Pass it, so
      // close_reaction_window never fired and the round can't finalize.
      // Migration 0104 stops cast_reaction_spell_card doing this going
      // forward; this clears any window a pre-0104 cast (or some unforeseen
      // path) already stranded, once this same 5-minute clock has elapsed.
      // With the window closed, advance_layer performs Layer finalization:
      // the window's roll-transform casts (Zariel's Fall, ...) apply and the
      // Layer resolves.
      const openWindow = await getOpenReactionWindow(supabase, roundId);
      if (openWindow && (await countEligibleReactionHolders(supabase, roundId)) === 0) {
        await closeReactionWindow(supabase, openWindow.windowId);
        await advanceRound(supabase, roundId, "stallCleared");
        return { action: "reactionWindowRecovered" };
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
  // single remaining roller isn't a failure to resolve — resolve_round
  // treats that lone roller as the outright winner of the tie, same as if
  // everyone else had simply lost the reroll outright.
  const remainingActiveCount = expectedPlayerIds.size - stalledPlayerIds.length;
  if (layer === 0 && remainingActiveCount < 2) {
    await cancelRound(supabase, roundId);
    await broadcastRoundCancelled(supabase, round.roomId, { roundId });
    return { action: "cancelled" };
  }

  // The Layer is now complete: at Layer 0 this opens the reaction window, at
  // a Tie-Break Reroll Layer it finalizes.
  await advanceRound(supabase, roundId, "stallCleared");
  return { action: "excluded", playerIds: stalledPlayerIds };
}
