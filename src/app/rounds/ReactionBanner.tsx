"use client";

import { useActionState } from "react";
import { useRoomRefresh } from "@/lib/room/roomViewContext";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import { castReactionSpellCardAction, passReactionWindowAction, spendCourageTokenAction } from "@/app/rounds/actions";
import type { SpellCastActionState } from "@/app/rounds/roundActionHelpers";
import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { CourageToken, ReactionStackEntry, ReactionWindowPendingPlayer } from "@/lib/supabase/reactionWindow";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { orderStackForResolution } from "@/lib/game/reactionStack";
import { joinNames } from "@/lib/game/displayName";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { SkipVote } from "@/app/rounds/SkipVote";
import type { SkipVoteState } from "@/lib/game/skipVote";

const initialCastState: SpellCastActionState = { status: "idle" };

const dieLabel = (dice: string) => dice.replace(/^1d/, "d");

export function ReactionBanner({
  roomId,
  roundId,
  selfPlayerId,
  eligible,
  alreadyPassed,
  heldReactionCard,
  stack,
  participants,
  pendingPlayers,
  skipVote,
  compelled = false,
  courageTokens = [],
}: {
  roomId: string;
  roundId: string;
  selfPlayerId: string;
  eligible: boolean;
  alreadyPassed: boolean;
  heldReactionCard: HeldSpellCard | null;
  stack: ReactionStackEntry[];
  participants: RoundParticipant[];
  pendingPlayers: ReactionWindowPendingPlayer[];
  skipVote: SkipVoteState | null;
  compelled?: boolean;
  courageTokens?: CourageToken[];
}) {
  const refresh = useRoomRefresh();
  const [castState, castFormAction] = useActionState(castReactionSpellCardAction, initialCastState);
  const [spendState, spendFormAction] = useActionState(spendCourageTokenAction, initialCastState);

  useRoomChannel(roomId, roundId, {
    "room-changed": () => refresh(),
    "round-revealed": () => refresh(),
    "layer-tied": () => refresh(),
  });

  const otherParticipants = participants.filter((p) => p.playerId !== selfPlayerId);
  const pendingNames = joinNames(pendingPlayers.map((p) => p.displayName), "");
  const negatableStack = orderStackForResolution(stack.filter((entry) => !entry.negated));

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t-4 border-gilt bg-tavern-panel p-3 shadow-[0_-8px_24px_rgb(0_0_0_/_0.5)]">
      <p className="mb-2 font-display text-sm uppercase tracking-widest text-gilt-bright">
        Reaction window open
      </p>

      {eligible && heldReactionCard && !alreadyPassed ? (
        <form action={castFormAction} className="mb-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="roundId" value={roundId} />
          <span className="font-body text-sm text-parchment">
            React with <strong className="text-gilt-bright">{heldReactionCard.cardName}</strong>?
          </span>

          {heldReactionCard.target === "OPPONENT" || heldReactionCard.target === "PLAYER" ? (
            <select
              name="targetPlayerId"
              required
              className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1 text-sm text-parchment focus:border-gilt focus:outline-none"
            >
              {(heldReactionCard.target === "PLAYER" ? participants : otherParticipants).map((p) => (
                <option key={p.playerId} value={p.playerId}>
                  {p.displayName ?? p.email}
                </option>
              ))}
            </select>
          ) : null}

          {heldReactionCard.target === "CARD" && negatableStack.length > 0 ? (
            <select
              name="targetCastId"
              required
              className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1 text-sm text-parchment focus:border-gilt focus:outline-none"
            >
              {negatableStack.map((entry) => (
                <option key={entry.castId} value={entry.castId}>
                  {entry.cardName} ({entry.casterName})
                </option>
              ))}
            </select>
          ) : null}

          <SubmitButton
            disabled={heldReactionCard.target === "CARD" && negatableStack.length === 0}
            className="rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
          >
            Cast
          </SubmitButton>

          {castState.status === "error" ? (
            <p role="alert" className="w-full font-body text-xs text-red-500">
              {castState.message}
            </p>
          ) : null}
        </form>
      ) : null}

      {eligible && courageTokens.length > 0 && !alreadyPassed ? (
        <form action={spendFormAction} className="mb-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="roundId" value={roundId} />
          <span className="font-body text-sm text-parchment">
            Spend a <strong className="text-gilt-bright">Courage Token</strong> from{" "}
            {courageTokens[0]!.giverDisplayName}
            {courageTokens.length > 1 ? ` (${courageTokens.length} held)` : ""}?
          </span>
          <SubmitButton className="rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
            Add {dieLabel(courageTokens[0]!.dice)}
          </SubmitButton>
          {spendState.status === "error" ? (
            <p role="alert" className="w-full font-body text-xs text-red-500">
              {spendState.message}
            </p>
          ) : null}
        </form>
      ) : null}

      {eligible && !alreadyPassed && compelled ? (
        <p className="font-body text-sm text-parchment">
          Brewmageddon: you must play your card — you can&apos;t pass.
        </p>
      ) : eligible && !alreadyPassed ? (
        <form action={passReactionWindowAction}>
          <input type="hidden" name="roundId" value={roundId} />
          <SubmitButton className="rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark disabled:cursor-not-allowed disabled:border-gilt-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
            Pass
          </SubmitButton>
        </form>
      ) : (
        <p className="font-body text-sm text-parchment-dim">
          {pendingNames
            ? `Waiting on ${pendingNames}…`
            : eligible
              ? "Waiting on other players…"
              : "Waiting for reactions…"}
        </p>
      )}

      {skipVote ? <SkipVote roundId={roundId} state={skipVote} /> : null}
    </div>
  );
}
