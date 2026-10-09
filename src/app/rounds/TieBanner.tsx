"use client";

import { useState } from "react";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { firstNameOrFallback, joinNames } from "@/lib/game/displayName";
import { TieRollModal } from "@/app/rounds/TieRollModal";

export type TiedParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  modifier: number;
  excludedAt: string | null;
};

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
  const [resolved, setResolved] = useState(false);

  useRoomChannel(roomId, roundId, {
    "round-revealed": () => setResolved(true),
  });

  if (resolved) return null;

  const activeTied = tiedParticipants.filter((p) => !p.excludedAt);
  const isTied = activeTied.some((p) => p.playerId === selfPlayerId);
  const tiedNames = activeTied.map((p) => firstNameOrFallback(p.displayName, p.email));
  const otherTiedNames = activeTied
    .filter((p) => p.playerId !== selfPlayerId)
    .map((p) => firstNameOrFallback(p.displayName, p.email));

  return (
    <>
      <p className="mb-2 text-center font-body text-sm text-parchment-dim">
        {joinNames(tiedNames, "Someone")} tied &mdash; rerolling&hellip;
      </p>

      {isTied ? (
        <TieRollModal
          roundId={roundId}
          ownRoll={ownRoll}
          rollInputMode={rollInputMode}
          otherTiedNames={otherTiedNames}
        />
      ) : null}
    </>
  );
}
