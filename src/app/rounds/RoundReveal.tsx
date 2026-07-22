"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type LayerRollsRevealedPayload, type RoundRevealedPayload } from "@/lib/supabase/realtime";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";

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
 */
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

  useEffect(() => {
    setRolls(null);
    setBrewerId(null);
  }, [roomId, roundId]);

  useRoomChannel(roomId, roundId, {
    "layer-rolls-revealed": (payload) => {
      setRolls(payload.rolls);
    },
    "round-revealed": (payload: RoundRevealedPayload) => {
      setRolls(payload.rolls);
      setBrewerId(payload.brewerId);
      setTimeout(() => router.refresh(), 1600);
    },
    "layer-tied": () => router.refresh(),
    "round-cancelled": () => router.refresh(),
  });

  const revealedValueByPlayerId = new Map(rolls?.map((r) => [r.playerId, r.value]) ?? []);

  return (
    <ul className="mt-3 divide-y divide-neutral-200 rounded border border-neutral-200">
      {participants.map((p) => {
        const revealedValue = revealedValueByPlayerId.get(p.playerId);
        const value = revealedValue ?? (p.playerId === selfPlayerId ? ownRoll : null);
        const isBrewer = brewerId === p.playerId;

        return (
          <li key={p.playerId} className="flex items-center justify-between px-3 py-2 text-sm">
            <span className="font-mono text-xs text-neutral-500">{p.modifier}</span>
            <span>{p.displayName ?? p.email}</span>
            <span
              className={`flex h-8 w-8 items-center justify-center rounded border text-sm font-mono ${
                value === null ? "animate-spin border-neutral-400" : "border-neutral-900"
              } ${isBrewer ? "bg-neutral-900 text-white" : ""}`}
            >
              {value ?? "?"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
