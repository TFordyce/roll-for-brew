"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type LayerRollsRevealedPayload, type RoundRevealedPayload } from "@/lib/supabase/realtime";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import { CardFrame } from "@/app/_components/CardFrame";

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
 * On round-revealed, a full-screen "Get the kettle on" modal covers the
 * result until dismissed (a deliberate exception to the no-full-screen-modal
 * precedent set for the reaction banner — this one's a one-off reveal beat,
 * not a recurring interruption). Dismissing it starts a 5-minute idle timer
 * that refreshes the page back to the normal room state, so a room nobody
 * dismisses/acts on doesn't sit on the results screen indefinitely.
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

  useEffect(() => {
    setRolls(null);
    setBrewerId(null);
    setShowKettleModal(false);
  }, [roomId, roundId]);

  useRoomChannel(roomId, roundId, {
    "layer-rolls-revealed": (payload) => {
      setRolls(payload.rolls);
    },
    "round-revealed": (payload: RoundRevealedPayload) => {
      setRolls(payload.rolls);
      setBrewerId(payload.brewerId);
      setShowKettleModal(true);
    },
    "layer-tied": () => router.refresh(),
    "round-cancelled": () => router.refresh(),
  });

  function dismissKettleModal() {
    setShowKettleModal(false);
    setTimeout(() => router.refresh(), RESULTS_TIMEOUT_MS);
  }

  const revealedValueByPlayerId = new Map(rolls?.map((r) => [r.playerId, r.value]) ?? []);
  const brewer = participants.find((p) => p.playerId === brewerId);

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
            const isBrewer = brewerId === p.playerId;

            return (
              <li key={p.playerId} className="flex items-center justify-between gap-3 py-2">
                <span className="font-mono text-xs text-parchment-dim">
                  {p.modifier >= 0 ? `+${p.modifier}` : p.modifier}
                </span>
                <span className="font-body text-sm text-parchment">{p.displayName ?? p.email}</span>
                <span
                  className={`flex h-9 w-9 items-center justify-center rounded-md border-2 font-display text-sm ${
                    value === null
                      ? "animate-spin border-gilt-dark text-parchment-dim"
                      : isBrewer
                        ? "border-gilt-bright bg-ember text-parchment shadow-[0_0_10px_theme(colors.gilt.DEFAULT)]"
                        : "border-gilt bg-tavern-panel-dark text-parchment"
                  }`}
                >
                  {value ?? "?"}
                </span>
              </li>
            );
          })}
        </ul>
      </CardFrame>
    </>
  );
}
