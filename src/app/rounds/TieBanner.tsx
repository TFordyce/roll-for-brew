"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { type LayerRollsRevealedPayload } from "@/lib/supabase/realtime";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { firstNameOrFallback } from "@/lib/game/displayName";
import { TieRollModal } from "@/app/rounds/TieRollModal";
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
 * active roll-in prompt, and (issue #220, piece 3) it's a modal (TieRollModal)
 * rather than an inline form — everyone else purely spectates. Listens for
 * the room's Realtime Broadcast channel the same way RoundReveal does, so a
 * further tie or the eventual reveal refreshes every device in lockstep
 * regardless of how many reroll layers it takes. Which input(s) a tied
 * player is offered follows their roll_input_mode preference (#22), same as
 * the plain layer-0 roll — a reroll is still "their turn to roll".
 *
 * Also listens for layer-rolls-revealed (issue #99) so a tied player's own
 * reroll shows its roll+modifier calculation the same way RoundReveal does
 * for layer 0, rather than leaving this layer's rolls unshown until the
 * round refreshes past the tie entirely. Filtered to this component's own
 * `layer`, since the channel isn't otherwise scoped below roundId and a
 * stray event from a prior layer could arrive right as this one mounts.
 */
export function TieBanner({
  roomId,
  roundId,
  layer,
  tiedParticipants,
  selfPlayerId,
  ownRoll,
  rollInputMode,
}: {
  roomId: string;
  roundId: string;
  layer: number;
  tiedParticipants: TiedParticipant[];
  selfPlayerId: string;
  ownRoll: number | null;
  rollInputMode: RollInputMode | null;
}) {
  const router = useRouter();
  const [rolls, setRolls] = useState<LayerRollsRevealedPayload["rolls"] | null>(null);

  useRoomChannel(roomId, roundId, {
    "layer-rolls-revealed": (payload) => {
      if (payload.layer === layer) setRolls(payload.rolls);
    },
    "round-revealed": () => router.refresh(),
    "layer-tied": () => router.refresh(),
    "round-cancelled": () => router.refresh(),
  });

  const isTied = tiedParticipants.some((p) => p.playerId === selfPlayerId && !p.excludedAt);
  const revealedValueByPlayerId = new Map(rolls?.map((r) => [r.playerId, r.value]) ?? []);
  const otherTiedNames = tiedParticipants
    .filter((p) => p.playerId !== selfPlayerId && !p.excludedAt)
    .map((p) => firstNameOrFallback(p.displayName, p.email));

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
            revealedRoll={
              revealedValueByPlayerId.get(p.playerId) ?? (p.playerId === selfPlayerId ? ownRoll : null)
            }
            joined
          />
        ))}
      </div>

      {!isTied ? (
        <p className="mt-3 font-body text-sm text-parchment-dim">Spectating &mdash; waiting for the reroll&hellip;</p>
      ) : null}

      {isTied ? (
        <TieRollModal
          roundId={roundId}
          ownRoll={ownRoll}
          rollInputMode={rollInputMode}
          otherTiedNames={otherTiedNames}
        />
      ) : null}
    </CardFrame>
  );
}
