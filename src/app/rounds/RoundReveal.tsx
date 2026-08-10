"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { type LayerRollsRevealedPayload, type RoundRevealedPayload } from "@/lib/supabase/realtime";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import { classifyRollCalculation } from "@/lib/game/rollCalculation";
import { buildRollCalculation } from "@/lib/game/rollCalculationEffects";
import { firstNameOrFallback } from "@/lib/game/displayName";
import { buildRerollChain } from "@/lib/game/rerollChain";
import { getRoundModifierEffectDetails, type ModifierEffectDetail } from "@/lib/supabase/spellCasts";
import { getRoundLayerHistory, type CompletedLayer } from "@/lib/supabase/rolls";
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
 *
 * Each row also carries any reroll history the player went through (issue
 * #220): once a layer-0 tie sends a player through one or more reroll
 * layers, buildRerollChain (src/lib/game/rerollChain.ts) walks
 * getRoundLayerHistory's full per-layer record into an ordered list of
 * dependent rows nested under that player's primary row — one per reroll
 * level, indented further for a chained tie, each rendered with the same
 * rich RollCalculation treatment as layer 0 (never a discarded die or
 * effect badge, since #219 fixed spell effects/reactions out of tie-break
 * rerolls entirely). This is layer history, not the live tie phase itself —
 * TieBanner still owns the roll-in prompt for whichever layer is currently
 * live (issue #220 piece 3) — so a given reroll level only shows up here
 * once its layer has fully completed.
 *
 * page.tsx keeps this component mounted for the round's entire closed
 * phase now, tie phase included (issue #220 piece 4) — not just after the
 * final layer resolves, as before. That matters beyond showing the nested
 * rows live: resolve_round already flips the round to 'resolved' by the
 * time round-revealed broadcasts (see layerResolution.ts's
 * applyLayerOutcome), so a round that ever tied would previously vanish
 * from the next server fetch before this component — the only thing that
 * actually holds rolls/brewerId/showKettleModal in local state and
 * deliberately avoids refreshing on round-revealed — ever got a chance to
 * mount and catch that broadcast at all.
 */
const RESULTS_TIMEOUT_MS = 5 * 60 * 1000;

// Static Tailwind margin-left classes for each reroll-chain nesting depth
// (issue #220 decision 3: "chained ties nest further, not in place") — a
// dynamically-interpolated arbitrary value (`ml-[${i * 20}px]`) can't be
// picked up by Tailwind's JIT purge, so each depth needs its own literal
// class. A chain nesting deeper than this list is vanishingly rare (it
// means the same tied subset rerolled and tied again this many times in a
// row); falls back to the deepest defined indent rather than stop indenting.
const REROLL_INDENT_CLASSES = ["ml-5", "ml-10", "ml-14", "ml-20", "ml-24"];
function rerollIndentClass(chainIndex: number): string {
  return REROLL_INDENT_CLASSES[chainIndex] ?? REROLL_INDENT_CLASSES[REROLL_INDENT_CLASSES.length - 1] ?? "ml-5";
}

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
  // The round's full reroll-layer history (issue #220), fetched alongside
  // effectDetails once rolls are known — feeds buildRerollChain's nested
  // dependent rows below. Best-effort like effectDetails: a fetch failure
  // just leaves every row without its reroll history rather than breaking
  // the reveal.
  const [history, setHistory] = useState<CompletedLayer[]>([]);
  // Bumped by every layer-rolls-revealed broadcast (any layer, not just 0)
  // and by round-revealed, to retrigger the history fetch below — issue
  // #220 piece 4's "the dependent row needs to populate live ... once a
  // layer's rolls are broadcast" requirement. Plain state instead of
  // folding into the `rolls` dependency below, since `rolls` itself now
  // only tracks layer 0's own reveal (see the two handlers further down).
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
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
    setHistory([]);
    setHistoryRefreshToken(0);
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

  useEffect(() => {
    if (rolls === null) return;
    let cancelled = false;
    const supabase = createClient();
    getRoundLayerHistory(supabase, roundId)
      .then((layers) => {
        if (!cancelled) setHistory(layers);
      })
      .catch(() => {
        // Best-effort — rows just render with no nested reroll history.
      });
    return () => {
      cancelled = true;
    };
    // historyRefreshToken is a deliberate extra trigger (see its own
    // comment above) — every reroll layer's own completion needs to
    // refetch this even though `rolls` (layer 0 only, below) doesn't change.
  }, [rolls, roundId, historyRefreshToken]);

  useRoomChannel(roomId, roundId, {
    // Scoped to layer 0 — this drives the *primary* row's own die (every
    // other layer's reveal only ever feeds the nested reroll rows via
    // historyRefreshToken below, never this state, or a mid-tie reroll's
    // reveal would incorrectly overwrite the primary row's already-known
    // layer-0 value).
    "layer-rolls-revealed": (payload) => {
      if (payload.layer === 0) setRolls(payload.rolls);
      setHistoryRefreshToken((t) => t + 1);
    },
    "round-revealed": (payload: RoundRevealedPayload) => {
      // Same layer-0 scoping as above: a round that went through one or
      // more ties can be decided by a reroll layer, and payload.rolls is
      // whichever layer that was (issue #220 piece 4) — never assume it's
      // layer 0's. The nested rows pick the final layer up via
      // historyRefreshToken instead, same as any other layer completion.
      if (payload.layer === 0) setRolls(payload.rolls);
      setHistoryRefreshToken((t) => t + 1);
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
            const rerollChain = buildRerollChain(p.playerId, history);

            return (
              <li key={p.playerId} className="py-2">
                <div className="flex items-center justify-between gap-3">
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
                        modifierTerms={built.modifierTerms}
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
                </div>

                {rerollChain.map((level, i) => {
                  // A reroll layer never carries a discarded die or effect
                  // badge (issue #219 exempted tie-break rerolls from both),
                  // so the total is always a plain roll+modifier sum, or the
                  // bare roll for a nat-1/nat-20 — same rule classifyRollCalculation
                  // applies to layer 0's own badge above.
                  const levelCalc = classifyRollCalculation(level.roll, level.modifier);
                  const levelBadgeValue = levelCalc.kind === "sum" ? levelCalc.total : level.roll;

                  return (
                    <div
                      key={level.layer}
                      className={`mt-1.5 flex items-center justify-between gap-3 border-l-2 border-dashed border-gilt-dark py-1.5 pl-3 ${rerollIndentClass(i)}`}
                    >
                      <span className="font-body text-[10px] uppercase tracking-widest text-parchment-dim">
                        Reroll {i + 1}
                        {level.tied ? (
                          <span className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-ember-bright bg-ember/25 px-2 py-0.5 text-[10px] normal-case tracking-normal text-parchment">
                            Tied again
                          </span>
                        ) : null}
                      </span>
                      <div className="flex items-center gap-2">
                        <RollCalculation roll={level.roll} modifier={level.modifier} rich discardedRoll={null} />
                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border-2 border-gilt bg-tavern-panel-dark font-display text-xs text-parchment">
                          {levelBadgeValue}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ul>
      </CardFrame>
    </>
  );
}
