"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { roomChannelName } from "@/lib/supabase/realtime";
import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { InAppRollForm, ManualRollForm } from "@/app/rounds/RollForms";
import { RollBothPicker } from "@/app/rounds/RollBothPicker";

export type TiedParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
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

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(roomChannelName(roomId));

    channel
      .on("broadcast", { event: "round-revealed" }, ({ payload }) => {
        const revealedPayload = payload as { roundId: string };
        if (revealedPayload.roundId !== roundId) return;
        router.refresh();
      })
      .on("broadcast", { event: "layer-tied" }, ({ payload }) => {
        const tiedPayload = payload as { roundId: string };
        if (tiedPayload.roundId !== roundId) return;
        router.refresh();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, roundId, router]);

  const isTied = tiedParticipants.some((p) => p.playerId === selfPlayerId);
  const names = tiedParticipants.map((p) => p.displayName ?? p.email).join(", ");

  return (
    <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-medium">Tied: {names} — rerolling</p>

      {isTied && ownRoll === null && rollInputMode === "in_app_only" ? (
        <InAppRollForm roundId={roundId} />
      ) : isTied && ownRoll === null && rollInputMode === "manual_only" ? (
        <ManualRollForm roundId={roundId} />
      ) : isTied && ownRoll === null && rollInputMode === "both" ? (
        <RollBothPicker roundId={roundId} />
      ) : isTied ? (
        <p className="mt-2 text-neutral-500">Waiting on the other tied player{tiedParticipants.length > 2 ? "s" : ""}&hellip;</p>
      ) : (
        <p className="mt-2 text-neutral-500">Spectating &mdash; waiting for the reroll&hellip;</p>
      )}
    </div>
  );
}
