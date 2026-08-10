import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { DispellableEffect, PendingCast } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { resolveCardSwapAction } from "@/app/rounds/actions";
import { CardFrame } from "@/app/_components/CardFrame";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { CastForm, DispelForm, TargetConfirmForm } from "@/app/rounds/SpellCardForms";

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
                <DispelForm roundId={roundId} cardName={held.cardName} dispellableEffects={dispellableEffects} />
              ) : (
                <p className="mt-2 font-body text-xs text-parchment-dim">Nothing eligible to end right now.</p>
              )
            ) : held.castingTime === "A" && held.target !== "CARD" && roundId && roundIsOpen ? (
              <CastForm roundId={roundId} held={held} participants={participants} selfPlayerId={selfPlayerId} />
            ) : null}
          </div>
        ) : null}

        {roundId && roundIsClosed && pendingCasts.length > 0
          ? pendingCasts.map((cast) => (
              <TargetConfirmForm
                key={cast.castId}
                roundId={roundId}
                cast={cast}
                options={cast.target === "PLAYER" || cast.target === "WILD" ? participants : otherParticipants}
              />
            ))
          : null}
      </CardFrame>
    </section>
  );
}
