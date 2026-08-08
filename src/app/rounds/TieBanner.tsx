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

/**
 * The tie phase's roll-in prompt (issue #20; slimmed for issue #220 piece 4).
 * page.tsx now keeps RoundReveal mounted for every closed round, tie phase
 * included, so RoundReveal's own roster list is what everyone actually sees
 * their rolls in — this banner only adds the two things RoundReveal can't:
 * a plain-text cue naming who's tied ("X and Y tied — rerolling…", shown to
 * everyone), and, on the tied player's own device only, TieRollModal — the
 * roll-in prompt itself (piece 3). Which input(s) a tied player is offered
 * follows their roll_input_mode preference (#22), same as the plain layer-0
 * roll — a reroll is still "their turn to roll".
 *
 * Why this used to refresh the whole page on round-revealed, and no longer
 * does: previously TieBanner was the *only* thing mounted during a tie, so a
 * blind `router.refresh()` on round-revealed was the only way to move on —
 * but resolve_round has already flipped the round to 'resolved' by the time
 * that broadcast fires (see layerResolution.ts's applyLayerOutcome), so the
 * very next server fetch finds no active round at all and the whole section
 * — RoundReveal included — would vanish before anyone saw the roll values,
 * brewer, or kettle modal RoundReveal exists to show. Piece 4 fixes that by
 * leaving the reveal to RoundReveal (now always mounted, listening for the
 * same broadcast, and deliberately *not* refreshing so its local rolls/
 * brewerId/showKettleModal state can survive the server round disappearing
 * underneath it). This banner just needs to get out of the way once that
 * happens: `resolved` hides it locally, same "don't force a refresh mid-
 * reveal" instinct, without duplicating RoundReveal's own result-holding
 * state. A genuine further tie is different — that's a real change in who's
 * expected to roll and what layer they're expected to roll it at, so it
 * still needs a fresh server fetch, which RoundReveal's own layer-tied
 * handler already triggers (both components share the same room channel);
 * this banner just remounts itself with the next layer's fresh props once
 * that refresh lands (page.tsx keys it by currentLayer).
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
  const [resolved, setResolved] = useState(false);

  useRoomChannel(roomId, roundId, {
    "round-revealed": () => setResolved(true),
    "round-cancelled": () => setResolved(true),
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
