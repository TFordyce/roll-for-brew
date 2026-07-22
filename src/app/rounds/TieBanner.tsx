"use client";

import { useRouter } from "next/navigation";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";
import { CardFrame } from "@/app/_components/CardFrame";
import { PlayerTile } from "@/app/_components/PlayerTile";

export type TiedParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  modifier: number;
  excludedAt: string | null;
};

/**
 * The tie phase view (issue #20): once a layer resolves to a tie, every
 * device — tied rerollers and spectators alike — swaps the roster for this
 * banner naming the tied players. Only a tied player's own device shows an
 * active roll input; everyone else purely spectates. Listens for the room's
 * Realtime Broadcast channel the same way RoundReveal does, so a further tie
 * or the eventual reveal refreshes every device in lockstep regardless of
 * how many reroll layers it takes. Which input(s) a tied player is offered
 * follows their roll_input_mode preference (#22), same as the plain
 * layer-0 roll — a reroll is still "their turn to roll".
 */
export function TieBanner({
  roomId,
  roundId,
  tiedParticipants,
  selfPlayerId,
  ownRoll,
  rollInputMode,
}: {
  roomId: string;
  roundId: string;
  tiedParticipants: TiedParticipant[];
  selfPlayerId: string;
  ownRoll: number | null;
  rollInputMode: RollInputMode | null;
}) {
  const router = useRouter();

  useRoomChannel(roomId, roundId, {
    "round-revealed": () => router.refresh(),
    "layer-tied": () => router.refresh(),
    "round-cancelled": () => router.refresh(),
  });

  const isTied = tiedParticipants.some((p) => p.playerId === selfPlayerId && !p.excludedAt);

  return (
    <CardFrame title="Tied — Rerolling">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
        {tiedParticipants.map((p) => (
          <PlayerTile
            key={p.playerId}
            displayName={p.displayName}
            email={p.email}
            avatarUrl={p.avatarUrl}
            modifier={p.modifier}
            joined
          />
        ))}
      </div>

      {isTied && ownRoll === null && rollInputMode ? (
        <RollInputPicker mode={rollInputMode} roundId={roundId} />
      ) : isTied ? (
        <p className="mt-3 font-body text-sm text-parchment-dim">
          Waiting on the other tied player{tiedParticipants.length > 2 ? "s" : ""}&hellip;
        </p>
      ) : (
        <p className="mt-3 font-body text-sm text-parchment-dim">Spectating &mdash; waiting for the reroll&hellip;</p>
      )}
    </CardFrame>
  );
}
