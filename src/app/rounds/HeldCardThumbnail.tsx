"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { DispellableEffect } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { cardTileView, TIER_BORDER, TIER_LABEL } from "@/lib/spellCollection";
import { CastForm, DispelForm } from "@/app/rounds/SpellCardForms";
import { CardInspectModal } from "@/app/_components/CardInspectModal";
import { MAX_TILT_DEG, TiltCardArt } from "@/app/_components/TiltCardArt";

type ArmedAction = { kind: "dispel" | "cast"; roundId: string };

export function HeldCardThumbnail({
  heldCards,
  dispellableEffects,
  roundId,
  roundIsOpen,
  participants,
  heistTargetIds,
  selfPlayerId,
  castNotice = null,
}: {
  heldCards: HeldSpellCard[];
  dispellableEffects: DispellableEffect[];
  roundId: string | null;
  roundIsOpen: boolean;
  participants: RoundParticipant[];
  heistTargetIds: string[];
  selfPlayerId: string;
  castNotice?: string | null;
}) {
  const held = heldCards.find((c) => c.location === "held");
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0 });
  const canTiltRef = useRef(false);

  useEffect(() => {
    canTiltRef.current = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }, []);

  useEffect(() => {
    setArmed(false);
    setOpen(false);
  }, [held?.instanceId]);

  if (!held) return null;

  const view = cardTileView({ name: held.cardName, tier: held.tier, drawCount: 1 });

  const armedAction: ArmedAction | null =
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
        </div>
      </button>

      {open ? (
        <CardInspectModal onClose={() => setOpen(false)}>
          <TiltCardArt artPath={view.artPath} artClassName={view.artClassName} className="mb-3" />
          <p className="font-display text-sm font-semibold uppercase tracking-wide text-gilt-bright">
            {held.cardName}
          </p>
          <p className="mt-0.5 font-mono text-xs text-parchment-dim">
            {TIER_LABEL[held.tier]} · {held.castingTime === "A" ? "Action" : "Reaction"} · {held.target}
          </p>
          <p className="mt-2 font-body text-sm text-parchment">{held.effectText}</p>

          {armedAction ? (
            armed ? (
              <>
                {armedAction.kind === "dispel" ? (
                  dispellableEffects.length > 0 ? (
                    <DispelForm
                      roundId={armedAction.roundId}
                      cardName={held.cardName}
                      dispellableEffects={dispellableEffects}
                    />
                  ) : (
                    <p className="mt-2 font-body text-xs text-parchment-dim">Nothing eligible to end right now.</p>
                  )
                ) : (
                  <CastForm
                    roundId={armedAction.roundId}
                    held={held}
                    participants={participants}
                    heistTargetIds={heistTargetIds}
                    selfPlayerId={selfPlayerId}
                    castNotice={castNotice}
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
        </CardInspectModal>
      ) : null}
    </>
  );
}
