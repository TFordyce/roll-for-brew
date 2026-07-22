import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { PendingCast } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import {
  castSpellCardAction,
  resolveCardSwapAction,
  setSpellCastTargetAction,
} from "@/app/rounds/actions";

/**
 * The docked held-card widget + casting/targeting/swap forms (issues #66/
 * #67). Kept as one panel (rather than the prototype PR #60's animated
 * widget) since the roster/dice-reveal UI polish pass is a later child of
 * the spec map (#65) — this ticket only needs casting to be functionally
 * possible.
 */
export function SpellCardPanel({
  heldCards,
  pendingCasts,
  roundId,
  roundIsOpen,
  roundIsClosed,
  participants,
  selfPlayerId,
}: {
  heldCards: HeldSpellCard[];
  pendingCasts: PendingCast[];
  roundId: string | null;
  roundIsOpen: boolean;
  roundIsClosed: boolean;
  participants: RoundParticipant[];
  selfPlayerId: string;
}) {
  const held = heldCards.find((c) => c.location === "held");
  const pendingSwap = heldCards.find((c) => c.location === "pending_swap");

  if (!held && !pendingSwap && pendingCasts.length === 0) return null;

  const otherParticipants = participants.filter((p) => p.playerId !== selfPlayerId);

  return (
    <section className="w-full max-w-sm rounded border border-purple-300 bg-purple-50 p-3 text-sm">
      <h3 className="mb-2 font-medium">Your spell card</h3>

      {pendingSwap ? (
        <div className="mb-2">
          <p>
            You drew <strong>{pendingSwap.cardName}</strong> ({pendingSwap.effectText}). Keep it, or
            keep your current card ({held?.cardName})?
          </p>
          <div className="mt-2 flex gap-2">
            <form action={resolveCardSwapAction}>
              <input type="hidden" name="keepNew" value="true" />
              <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-white">
                Keep {pendingSwap.cardName}
              </button>
            </form>
            <form action={resolveCardSwapAction}>
              <input type="hidden" name="keepNew" value="false" />
              <button type="submit" className="rounded border border-neutral-900 px-3 py-1.5">
                Keep {held?.cardName}
              </button>
            </form>
          </div>
        </div>
      ) : held ? (
        <div className="mb-2">
          <p className="font-semibold">{held.cardName}</p>
          <p className="text-xs text-neutral-600">
            {held.tier} · {held.castingTime === "A" ? "Action" : "Reaction"} · {held.target}
          </p>
          <p>{held.effectText}</p>

          {held.castingTime === "A" && roundId && roundIsOpen ? (
            <form action={castSpellCardAction} className="mt-2">
              <input type="hidden" name="roundId" value={roundId} />
              {held.target === "SELF" ? null : (
                <select
                  name="targetPlayerId"
                  defaultValue=""
                  className="mb-2 w-full rounded border border-neutral-300 px-2 py-1"
                >
                  <option value="">Decide target once declare-in closes</option>
                  {(held.target === "PLAYER"
                    ? participants
                    : otherParticipants
                  ).map((p) => (
                    <option key={p.playerId} value={p.playerId}>
                      {p.displayName ?? p.email}
                    </option>
                  ))}
                </select>
              )}
              <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-white">
                Cast {held.cardName}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {roundId && roundIsClosed && pendingCasts.length > 0
        ? pendingCasts.map((cast) => (
            <form key={cast.castId} action={setSpellCastTargetAction} className="mt-2">
              <input type="hidden" name="castId" value={cast.castId} />
              <p className="mb-1">
                Choose a target for <strong>{cast.cardName}</strong>:
              </p>
              <select
                name="targetPlayerId"
                required
                className="mb-2 w-full rounded border border-neutral-300 px-2 py-1"
              >
                {(cast.target === "PLAYER" ? participants : otherParticipants).map((p) => (
                  <option key={p.playerId} value={p.playerId}>
                    {p.displayName ?? p.email}
                  </option>
                ))}
              </select>
              <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-white">
                Confirm target
              </button>
            </form>
          ))
        : null}
    </section>
  );
}
