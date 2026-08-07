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
import { SubmitButton } from "@/app/_components/SubmitButton";

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
  roomId,
}: {
  heldCards: HeldSpellCard[];
  pendingCasts: PendingCast[];
  dispellableEffects: DispellableEffect[];
  roundId: string | null;
  roundIsOpen: boolean;
  roundIsClosed: boolean;
  participants: RoundParticipant[];
  selfPlayerId: string;
  roomId: string;
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
                <input type="hidden" name="roomId" value={roomId} />
                <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
                  Keep {pendingSwap.cardName}
                </SubmitButton>
              </form>
              <form action={resolveCardSwapAction} className="flex-1">
                <input type="hidden" name="keepNew" value="false" />
                <input type="hidden" name="roomId" value={roomId} />
                <SubmitButton className="w-full rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark disabled:cursor-not-allowed disabled:border-gilt-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
                  Keep {held?.cardName}
                </SubmitButton>
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
                  <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
                    End effect with {held.cardName}
                  </SubmitButton>
                </form>
              ) : (
                <p className="mt-2 font-body text-xs text-parchment-dim">Nothing eligible to end right now.</p>
              )
            ) : held.castingTime === "A" && held.target !== "CARD" && roundId && roundIsOpen ? (
              <form action={castSpellCardAction} className="mt-3">
                <input type="hidden" name="roundId" value={roundId} />
                {held.target === "OPPONENT" || held.target === "PLAYER" ? (
                  <p className="mb-2 font-body text-xs text-parchment-dim">
                    Target is chosen once declare-in closes and the roster is final.
                  </p>
                ) : held.target === "CHOSEN_PLAYERS" ? (
                  <fieldset className="mb-2">
                    <legend className="mb-1 font-body text-xs text-parchment-dim">Choose up to 3 players:</legend>
                    <div className="flex flex-col gap-1">
                      {participants
                        .filter((p) => p.playerId !== selfPlayerId)
                        .map((p) => (
                          <label key={p.playerId} className="flex items-center gap-2 font-body text-sm text-parchment">
                            <input type="checkbox" name="chosenPlayerIds" value={p.playerId} />
                            {p.displayName ?? p.email}
                          </label>
                        ))}
                    </div>
                  </fieldset>
                ) : held.effectKind === "declared_number_tea_maker" ? (
                  <label className="mb-2 block font-body text-xs text-parchment-dim">
                    Declare a number (1–20):
                    <input
                      type="number"
                      name="declaredNumber"
                      min={1}
                      max={20}
                      required
                      className="mt-1 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
                    />
                  </label>
                ) : null}
                <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
                  Cast {held.cardName}
                </SubmitButton>
              </form>
            ) : null}
          </div>
        ) : null}

        {roundId && roundIsClosed && pendingCasts.length > 0
          ? pendingCasts.map((cast) => (
              <form key={cast.castId} action={setSpellCastTargetAction} className="mt-3 first:mt-0">
                <input type="hidden" name="castId" value={cast.castId} />
                <input type="hidden" name="roundId" value={roundId} />
                <p className="mb-1 font-body text-sm text-parchment">
                  Choose a target for <strong className="text-gilt-bright">{cast.cardName}</strong>:
                </p>
                <select
                  name="targetPlayerId"
                  required
                  className="mb-2 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
                >
                  {(cast.target === "PLAYER" || cast.target === "WILD" ? participants : otherParticipants).map((p) => (
                    <option key={p.playerId} value={p.playerId}>
                      {p.displayName ?? p.email}
                    </option>
                  ))}
                </select>
                <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
                  Confirm target
                </SubmitButton>
              </form>
            ))
          : null}
      </CardFrame>
    </section>
  );
}
