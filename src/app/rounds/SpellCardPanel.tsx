import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { PendingCast } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { resolveCardSwapAction } from "@/app/rounds/actions";
import { CardFrame } from "@/app/_components/CardFrame";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { TargetConfirmForm } from "@/app/rounds/SpellCardForms";

/**
 * The pending-decision prompts that aren't about the held card's own display
 * (issue #266 split this out of the old combined "Your Spell Card" panel):
 * the keep-or-swap decision after a nat-1/nat-20 draw, and target
 * confirmation for casts armed before declare-in closed. The held card
 * itself now lives in the docked `HeldCardThumbnail`. The two prompts get
 * their own titled `CardFrame`s (rather than one shared title) since they
 * can coexist and answer different questions.
 */
export function SpellCardPanel({
  heldCards,
  pendingCasts,
  roundId,
  roundIsClosed,
  participants,
  selfPlayerId,
  roomId,
}: {
  heldCards: HeldSpellCard[];
  pendingCasts: PendingCast[];
  roundId: string | null;
  roundIsClosed: boolean;
  participants: RoundParticipant[];
  selfPlayerId: string;
  roomId: string;
}) {
  const held = heldCards.find((c) => c.location === "held");
  const pendingSwap = heldCards.find((c) => c.location === "pending_swap");
  const hasPendingCasts = !!roundId && roundIsClosed && pendingCasts.length > 0;

  if (!pendingSwap && !hasPendingCasts) return null;

  const otherParticipants = participants.filter((p) => p.playerId !== selfPlayerId);

  return (
    <section className="flex w-full max-w-sm flex-col gap-3">
      {pendingSwap ? (
        <CardFrame title="Keep New Card?">
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
        </CardFrame>
      ) : null}

      {roundId && roundIsClosed && pendingCasts.length > 0 ? (
        <CardFrame title="Confirm Target">
          {pendingCasts.map((cast) => (
            <TargetConfirmForm
              key={cast.castId}
              roundId={roundId}
              cast={cast}
              options={cast.target === "PLAYER" || cast.target === "WILD" ? participants : otherParticipants}
            />
          ))}
        </CardFrame>
      ) : null}
    </section>
  );
}
