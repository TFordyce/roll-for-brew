import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { DispellableEffect, PendingCast } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import {
  castSpellCardAction,
  endActiveEffectAction,
  resolveCardSwapAction,
  setSpellCastTargetAction,
} from "@/app/rounds/actions";
import { CardFrame } from "@/app/_components/CardFrame";

/**
 * The docked held-card widget + casting/targeting/swap forms (issues #66/
 * #67/#69). Kept as one panel (rather than the prototype PR #60's animated
 * widget) since the roster/dice-reveal UI polish pass is a later child of
 * the spec map (#65) — this ticket only needs casting to be functionally
 * possible.
 */
export function SpellCardPanel({
  heldCards,
  pendingCasts,
  dispellableEffects,
  roundId,
  roundIsOpen,
  roundIsClosed,
  participants,
  selfPlayerId,
}: {
  heldCards: HeldSpellCard[];
  pendingCasts: PendingCast[];
  dispellableEffects: DispellableEffect[];
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
    <section className="w-full max-w-sm">
      <CardFrame title="Your Spell Card">
        {pendingSwap ? (
          <div>
            <p className="font-body text-sm text-parchment">
              You drew <strong className="text-gilt-bright">{pendingSwap.cardName}</strong> (
              {pendingSwap.effectText}). Keep it, or keep your current card ({held?.cardName})?
            </p>
            <div className="mt-3 flex gap-2">
              <form action={resolveCardSwapAction} className="flex-1">
                <input type="hidden" name="keepNew" value="true" />
                <button
                  type="submit"
                  className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
                >
                  Keep {pendingSwap.cardName}
                </button>
              </form>
              <form action={resolveCardSwapAction} className="flex-1">
                <input type="hidden" name="keepNew" value="false" />
                <button
                  type="submit"
                  className="w-full rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
                >
                  Keep {held?.cardName}
                </button>
              </form>
            </div>
          </div>
        ) : held ? (
          <div>
            <p className="font-display text-sm font-semibold uppercase tracking-wide text-gilt-bright">
              {held.cardName}
            </p>
            <p className="mt-0.5 font-mono text-xs text-parchment-dim">
              {held.tier} · {held.castingTime === "A" ? "Action" : "Reaction"} · {held.target}
            </p>
            <p className="mt-1 font-body text-sm text-parchment">{held.effectText}</p>

            {held.castingTime === "A" && held.effectKind === "dispel" && roundId && roundIsOpen ? (
              dispellableEffects.length > 0 ? (
                <form action={endActiveEffectAction} className="mt-3">
                  <input type="hidden" name="roundId" value={roundId} />
                  <select
                    name="effectId"
                    required
                    className="mb-2 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
                  >
                    {dispellableEffects.map((effect) => (
                      <option key={effect.effectId} value={effect.effectId}>
                        {effect.cardName} on {effect.targetDisplayName} ({effect.tier})
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
                  >
                    End effect with {held.cardName}
                  </button>
                </form>
              ) : (
                <p className="mt-2 font-body text-xs text-parchment-dim">Nothing eligible to end right now.</p>
              )
            ) : held.castingTime === "A" && held.target !== "CARD" && roundId && roundIsOpen ? (
              <form action={castSpellCardAction} className="mt-3">
                <input type="hidden" name="roundId" value={roundId} />
                {held.target === "SELF" ? null : (
                  <p className="mb-2 font-body text-xs text-parchment-dim">
                    Target is chosen once declare-in closes and the roster is final.
                  </p>
                )}
                <button
                  type="submit"
                  className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
                >
                  Cast {held.cardName}
                </button>
              </form>
            ) : null}
          </div>
        ) : null}

        {roundId && roundIsClosed && pendingCasts.length > 0
          ? pendingCasts.map((cast) => (
              <form key={cast.castId} action={setSpellCastTargetAction} className="mt-3 first:mt-0">
                <input type="hidden" name="castId" value={cast.castId} />
                <p className="mb-1 font-body text-sm text-parchment">
                  Choose a target for <strong className="text-gilt-bright">{cast.cardName}</strong>:
                </p>
                <select
                  name="targetPlayerId"
                  required
                  className="mb-2 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
                >
                  {(cast.target === "PLAYER" ? participants : otherParticipants).map((p) => (
                    <option key={p.playerId} value={p.playerId}>
                      {p.displayName ?? p.email}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
                >
                  Confirm target
                </button>
              </form>
            ))
          : null}
      </CardFrame>
    </section>
  );
}
