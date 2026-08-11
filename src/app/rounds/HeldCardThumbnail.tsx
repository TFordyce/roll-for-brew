"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { DispellableEffect } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { cardTileView, TIER_BORDER, TIER_LABEL } from "@/lib/spellCollection";
import { CastForm, DispelForm } from "@/app/rounds/SpellCardForms";

const MAX_TILT_DEG = 16;

type ArmEligibility = { kind: "dispel" | "cast"; roundId: string };

/**
 * The docked held-card widget (issue #266's split of the old `SpellCardPanel`
 * "Your Spell Card" block): a mini card tile fixed bottom-right, tilting
 * toward the pointer, that opens a modal for the full art/text and — once
 * "Arm"ed — the existing Cast/Dispel form underneath. Renders nothing when
 * there's no held card, mirroring `SpellCardPanel`'s old gate.
 *
 * Reuses `cardTileView`/`TIER_BORDER` (lib/spellCollection.ts) for the
 * art/border treatment rather than inventing a second rendering path, and
 * the modal overlay pattern from `SpellCollectionGrid`'s inspect modal.
 *
 * Arm/disarm: closing the modal or reopening it does *not* by itself clear
 * an armed card — the glowing border on the collapsed thumbnail exists
 * precisely so a "loaded" card stays visibly primed while you're doing
 * something else. The only ways to clear it are an explicit Disarm inside
 * the modal, or actually casting the card (which moves it out of `held` on
 * the next server round-trip, so the `instanceId` effect below resets the
 * local state along with it).
 */
export function HeldCardThumbnail({
  heldCards,
  dispellableEffects,
  roundId,
  roundIsOpen,
  participants,
  selfPlayerId,
}: {
  heldCards: HeldSpellCard[];
  dispellableEffects: DispellableEffect[];
  roundId: string | null;
  roundIsOpen: boolean;
  participants: RoundParticipant[];
  selfPlayerId: string;
}) {
  const held = heldCards.find((c) => c.location === "held");
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0 });
  const canTiltRef = useRef(false);

  useEffect(() => {
    canTiltRef.current = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }, []);

  // A different held card (a new draw, or this one just got spent) starts
  // fresh — armed/open state from the previous card shouldn't leak forward.
  useEffect(() => {
    setArmed(false);
    setOpen(false);
  }, [held?.instanceId]);

  if (!held) return null;

  const view = cardTileView({ name: held.cardName, tier: held.tier, drawCount: 1 });

  const armEligibility: ArmEligibility | null =
    held.castingTime === "A" && held.effectKind === "dispel" && roundId && roundIsOpen
      ? { kind: "dispel", roundId }
      : held.castingTime === "A" && held.target !== "CARD" && roundId && roundIsOpen
        ? { kind: "cast", roundId }
        : null;

  function handleMouseMove(event: MouseEvent<HTMLButtonElement>) {
    if (!canTiltRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    setTilt({ rotateX: -dy * MAX_TILT_DEG, rotateY: dx * MAX_TILT_DEG });
  }

  function handleMouseLeave() {
    setTilt({ rotateX: 0, rotateY: 0 });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ transform: `perspective(600px) rotateX(${tilt.rotateX}deg) rotateY(${tilt.rotateY}deg)` }}
        aria-label={`View held card: ${held.cardName}`}
        className={`fixed bottom-4 right-4 z-30 w-16 overflow-hidden rounded-md border-[3px] bg-tavern-panel-dark text-left transition-transform duration-150 ease-out ${TIER_BORDER[held.tier]} ${
          armed ? "shadow-[0_0_18px_4px_rgb(212_175_55_/_0.85)]" : ""
        }`}
      >
        <div className="relative aspect-[3/4] w-full overflow-hidden bg-tavern-plank-dark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={view.artPath} alt="" className={`h-full w-full object-cover ${view.artClassName}`} />
          <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 py-0.5 font-display text-[7px] uppercase tracking-widest text-gilt-bright">
            {TIER_LABEL[held.tier]}
          </span>
        </div>
        <p className="truncate px-1 py-1 font-display text-[9px] uppercase tracking-wide text-parchment">
          {held.cardName}
        </p>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xs rounded-lg border-4 border-gilt bg-tavern-panel p-4 shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.6)]"
          >
            <div className="mb-3 aspect-[3/4] w-full overflow-hidden rounded-md bg-tavern-plank-dark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={view.artPath} alt="" className={`h-full w-full object-cover ${view.artClassName}`} />
            </div>
            <p className="font-display text-sm font-semibold uppercase tracking-wide text-gilt-bright">
              {held.cardName}
            </p>
            <p className="mt-0.5 font-mono text-xs text-parchment-dim">
              {TIER_LABEL[held.tier]} · {held.castingTime === "A" ? "Action" : "Reaction"} · {held.target}
            </p>
            <p className="mt-2 font-body text-sm text-parchment">{held.effectText}</p>

            {armEligibility ? (
              armed ? (
                <>
                  {armEligibility.kind === "dispel" ? (
                    dispellableEffects.length > 0 ? (
                      <DispelForm
                        roundId={armEligibility.roundId}
                        cardName={held.cardName}
                        dispellableEffects={dispellableEffects}
                      />
                    ) : (
                      <p className="mt-2 font-body text-xs text-parchment-dim">Nothing eligible to end right now.</p>
                    )
                  ) : (
                    <CastForm
                      roundId={armEligibility.roundId}
                      held={held}
                      participants={participants}
                      selfPlayerId={selfPlayerId}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setArmed(false)}
                    className="mt-2 w-full rounded-md border-2 border-gilt-dark px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment-dim hover:bg-tavern-panel-dark"
                  >
                    Disarm
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setArmed(true)}
                  className="mt-3 w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
                >
                  Arm
                </button>
              )
            ) : null}

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-3 w-full rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
