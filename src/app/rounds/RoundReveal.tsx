"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { type LayerRollsRevealedPayload, type RoundRevealedPayload } from "@/lib/supabase/realtime";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import { classifyRollCalculation } from "@/lib/game/rollCalculation";
import { buildRollCalculation } from "@/lib/game/rollCalculationEffects";
import { firstNameOrFallback } from "@/lib/game/displayName";
import { getRoundModifierEffectDetails, type ModifierEffectDetail } from "@/lib/supabase/spellCasts";
import { CardFrame } from "@/app/_components/CardFrame";
import { RollCalculation } from "@/app/_components/RollCalculation";
import { ModifierBreakdown } from "@/app/_components/ModifierBreakdown";

export type RoundRevealParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
  modifier: number;
};

/**
 * The layer-0 dice view (prototype Variant A:
 * prototype/roll-reveal-ui/index.html). Every participant's die spins until
 * one of three things happens: the caller personally submits their own roll
 * (that one die flips immediately — "hidden from everyone but not from
 * yourself once you've rolled"), the room's Realtime Broadcast channel
 * delivers layer-rolls-revealed (every die flips to its actual value, in
 * lockstep, but with nobody highlighted as brewer yet — issue #68: this is
 * the moment the reaction window, rendered above/alongside this component in
 * page.tsx via ReactionBanner, can open), or it delivers round-revealed
 * (the brewer is now decided — highlights them and, after a beat, refreshes
 * to move on). round-revealed no longer necessarily follows
 * layer-rolls-revealed immediately: a reaction window, and any
 * forced-reroll-in-place effect it resolves into, can sit between them with
 * no timeout of its own. Also listens for layer-tied (issue #20): if layer 0
 * itself ties, every device needs to swap this roster for the tie banner, so
 * it refreshes just like a reveal does.
 *
 * On round-revealed, the losing player (the brewer) gets a full-screen
 * "Get the kettle on" modal covering the result until they dismiss it (a
 * deliberate exception to the no-full-screen-modal precedent set for the
 * reaction banner — this one's a one-off reveal beat aimed only at the
 * brewer, not a recurring interruption for everyone). Everyone else sees the
 * results immediately, no modal. Once results are visible to a given
 * player — immediately for non-brewers, on dismiss for the brewer — a
 * 5-minute idle timer refreshes the page back to the normal room state, so a
 * room nobody navigates away from doesn't sit on the results screen
 * indefinitely. The timer is cleared on unmount so navigating away cancels
 * it rather than firing late.
 */
const RESULTS_TIMEOUT_MS = 5 * 60 * 1000;

export function RoundReveal({
  roomId,
  roundId,
  participants,
  selfPlayerId,
  ownRoll,
}: {
  roomId: string;
  roundId: string;
  participants: RoundRevealParticipant[];
  selfPlayerId: string;
  ownRoll: number | null;
}) {
  const router = useRouter();
  const [rolls, setRolls] = useState<LayerRollsRevealedPayload["rolls"] | null>(null);
  const [brewerId, setBrewerId] = useState<string | null>(null);
  const [showKettleModal, setShowKettleModal] = useState(false);
  // Per-effect detail rows (issue #167) for this round's spell-effect
  // badges — fetched client-side once rolls are known, since neither
  // realtime broadcast carries them (they're keyed off the round, not a
  // specific reveal event). Best-effort: RollCalculation just renders
  // without badges if this fetch fails.
  const [effectDetails, setEffectDetails] = useState<ModifierEffectDetail[]>([]);
  const resultsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearResultsTimeout() {
    if (resultsTimeoutRef.current !== null) {
      clearTimeout(resultsTimeoutRef.current);
      resultsTimeoutRef.current = null;
    }
  }

  function startResultsTimeout() {
    clearResultsTimeout();
    resultsTimeoutRef.current = setTimeout(() => router.refresh(), RESULTS_TIMEOUT_MS);
  }

  useEffect(() => {
    setRolls(null);
    setBrewerId(null);
    setShowKettleModal(false);
    setEffectDetails([]);
    clearResultsTimeout();
    return clearResultsTimeout;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, roundId]);

  useEffect(() => {
    if (rolls === null) return;
    let cancelled = false;
    const supabase = createClient();
    getRoundModifierEffectDetails(supabase, roundId)
      .then((details) => {
        if (!cancelled) setEffectDetails(details);
      })
      .catch(() => {
        // Best-effort — badges just stay empty, the roll+total math still renders.
      });
    return () => {
      cancelled = true;
    };
  }, [rolls, roundId]);

  useRoomChannel(roomId, roundId, {
    "layer-rolls-revealed": (payload) => {
      setRolls(payload.rolls);
    },
    "round-revealed": (payload: RoundRevealedPayload) => {
      setRolls(payload.rolls);
      setBrewerId(payload.brewerId);
      if (payload.brewerId === selfPlayerId) {
        setShowKettleModal(true);
      } else {
        startResultsTimeout();
      }
    },
    "layer-tied": () => router.refresh(),
    "round-cancelled": () => router.refresh(),
  });

  function dismissKettleModal() {
    setShowKettleModal(false);
    startResultsTimeout();
  }

  const revealedValueByPlayerId = new Map(rolls?.map((r) => [r.playerId, r.value]) ?? []);
  const discardedValueByPlayerId = new Map(rolls?.map((r) => [r.playerId, r.discardedValue]) ?? []);
  const brewer = participants.find((p) => p.playerId === brewerId);
  const displayNameByPlayerId = new Map(participants.map((p) => [p.playerId, p.displayName ?? p.email]));
  const casterName = (playerId: string) => displayNameByPlayerId.get(playerId) ?? playerId;

  return (
    <>
      {showKettleModal && brewer ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="rounded-lg border-4 border-gilt bg-tavern-panel p-6 text-center shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.5)]">
            <p className="font-display text-xl font-semibold uppercase tracking-widest text-gilt-bright">
              Get the kettle on, {brewer.displayName ?? brewer.email}
            </p>
            <button
              type="button"
              onClick={dismissKettleModal}
              className="mt-5 w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
            >
              Show results
            </button>
          </div>
        </div>
      ) : null}

      <CardFrame title="Rolling">
        <ul className="divide-y divide-gilt-dark/40">
          {participants.map((p) => {
            const revealedValue = revealedValueByPlayerId.get(p.playerId);
            const value = revealedValue ?? (p.playerId === selfPlayerId ? ownRoll : null);
            // Only known once the layer-rolls-revealed/round-revealed
            // broadcast lands — during the brief self-only ownRoll fallback
            // window there's no discarded-roll data yet, so it's just
            // withheld until the real broadcast corrects it moments later.
            const discardedValue = discardedValueByPlayerId.get(p.playerId) ?? null;
            const isBrewer = brewerId === p.playerId;
            const effectsForPlayer = effectDetails.filter((d) => d.targetPlayerId === p.playerId);
            // p.modifier is the player's persistent room modifier, not the
            // round's true modifier — spell effects (issue #165's widened
            // query) can still change it, so it has to be recomposed here
            // (issue #166's classifyEffectImpact feeds the same recompose).
            const built = buildRollCalculation(p.modifier, effectsForPlayer, casterName);
            // The badge must show the same value the inline RollCalculation
            // expression shows and resolveLayer actually compares — roll +
            // modifier for an ordinary roll, but the bare roll for nat-1/
            // nat-20, which resolve by their own rule regardless of modifier
            // (issue #153).
            const calc = value === null ? null : classifyRollCalculation(value, built.composedModifier);
            const badgeValue = calc === null ? null : calc.kind === "sum" ? calc.total : value;

            return (
              <li key={p.playerId} className="flex items-center justify-between gap-3 py-2">
                <ModifierBreakdown playerId={p.playerId} roomId={roomId} modifier={p.modifier} />
                <div className="flex min-w-0 flex-1 flex-col gap-y-0.5 sm:flex-row sm:items-center sm:gap-x-2">
                  <span className="font-body text-sm text-parchment" title={p.displayName ?? p.email}>
                    {firstNameOrFallback(p.displayName, p.email)}
                  </span>
                  {value !== null ? (
                    <RollCalculation
                      roll={value}
                      modifier={built.composedModifier}
                      rich
                      discardedRoll={discardedValue}
                      diceTerms={built.diceTerms}
                      effects={built.effects}
                    />
                  ) : null}
                </div>
                <span
                  className={`flex h-9 w-9 items-center justify-center rounded-md border-2 font-display text-sm ${
                    value === null
                      ? "animate-spin border-gilt-dark text-parchment-dim"
                      : isBrewer
                        ? "border-gilt-bright bg-ember text-parchment shadow-[0_0_10px_theme(colors.gilt.DEFAULT)]"
                        : "border-gilt bg-tavern-panel-dark text-parchment"
                  }`}
                >
                  {badgeValue ?? "?"}
                </span>
              </li>
            );
          })}
        </ul>
      </CardFrame>
    </>
  );
}
