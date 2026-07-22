"use client";

import { useRouter } from "next/navigation";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import { castReactionSpellCardAction, passReactionWindowAction } from "@/app/rounds/actions";
import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { ReactionStackEntry } from "@/lib/supabase/reactionWindow";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { orderStackForResolution } from "@/lib/game/reactionStack";

/**
 * The reaction window's ribbon banner (issue #68): a bottom bar over the
 * already-revealed dice screen (RoundReveal/TieBanner render above it, not
 * behind a dimming overlay) rather than a full-screen modal, per the map's
 * user story 26. No timer anywhere in this component — the window only
 * closes when passReactionWindowAction reports every eligible holder has
 * passed, driven entirely by user action and realtime broadcasts.
 */
export function ReactionBanner({
  roomId,
  roundId,
  selfPlayerId,
  eligible,
  alreadyPassed,
  heldReactionCard,
  stack,
  participants,
}: {
  roomId: string;
  roundId: string;
  selfPlayerId: string;
  eligible: boolean;
  alreadyPassed: boolean;
  heldReactionCard: HeldSpellCard | null;
  stack: ReactionStackEntry[];
  participants: RoundParticipant[];
}) {
  const router = useRouter();

  useRoomChannel(roomId, roundId, {
    "reaction-window-changed": () => router.refresh(),
    "round-revealed": () => router.refresh(),
    "layer-tied": () => router.refresh(),
  });

  const otherParticipants = participants.filter((p) => p.playerId !== selfPlayerId);
  // A CARD-target reaction (contested_negate/redirect) can only target a
  // stack entry that hasn't already been negated by an earlier reaction.
  // Ordered LIFO (most recently cast first, src/lib/game/reactionStack.ts)
  // so the picker offers the top of the stack first — the entry a further
  // reaction would most naturally be responding to.
  const negatableStack = orderStackForResolution(stack.filter((entry) => !entry.negated));

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t-4 border-gilt bg-tavern-panel p-3 shadow-[0_-8px_24px_rgb(0_0_0_/_0.5)]">
      <p className="mb-2 font-display text-sm uppercase tracking-widest text-gilt-bright">
        Reaction window open
        {stack.length > 0 ? ` — ${stack.length} card${stack.length > 1 ? "s" : ""} on the stack` : ""}
      </p>

      {stack.length > 0 ? (
        <ul className="mb-2 space-y-0.5 font-body text-xs text-parchment-dim">
          {stack.map((entry) => (
            <li key={entry.castId}>
              {entry.casterName} cast <strong className="text-parchment">{entry.cardName}</strong>
              {entry.negated ? " (negated)" : ""}
            </li>
          ))}
        </ul>
      ) : null}

      {eligible && heldReactionCard && !alreadyPassed ? (
        <form action={castReactionSpellCardAction} className="mb-2 flex flex-wrap items-center gap-2">
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

          <button
            type="submit"
            disabled={heldReactionCard.target === "CARD" && negatableStack.length === 0}
            className="rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
          >
            Cast
          </button>
        </form>
      ) : null}

      {eligible && !alreadyPassed ? (
        <form action={passReactionWindowAction}>
          <input type="hidden" name="roundId" value={roundId} />
          <button
            type="submit"
            className="rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
          >
            Pass
          </button>
        </form>
      ) : eligible ? (
        <p className="font-body text-sm text-parchment-dim">Waiting on other players&hellip;</p>
      ) : (
        <p className="font-body text-sm text-parchment-dim">Waiting for reactions&hellip;</p>
      )}
    </div>
  );
}
