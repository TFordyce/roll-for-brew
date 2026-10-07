import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { CompelledCast, DispellableEffect } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { joinNames } from "@/lib/game/displayName";
import { CardFrame } from "@/app/_components/CardFrame";
import { CastForm, DispelForm } from "@/app/rounds/SpellCardForms";

/**
 * Brewmageddon's Compelled Cast (issue #440). For a player who owes a cast:
 * an Action card is cast right here, in the Compelled Cast step, with its
 * target named now; a Reaction card waits for the Layer-0 Reaction Window,
 * where ReactionBanner offers no Pass. For everyone else while the step is
 * holding rolling: who the table is waiting on.
 */
export function CompelledCastPanel({
  roundId,
  compelled,
  held,
  brewmageddonCasterName,
  waitingOnNames,
  participants,
  selfPlayerId,
  dispellableEffects,
  heistTargetIds,
  castNotice = null,
}: {
  roundId: string;
  compelled: CompelledCast | null;
  held: HeldSpellCard | null;
  brewmageddonCasterName: string;
  /** Other players who still owe a compelled Action cast (rolling is held meanwhile). */
  waitingOnNames: string[];
  participants: RoundParticipant[];
  selfPlayerId: string;
  dispellableEffects: DispellableEffect[];
  /** Issue #438: Tea Heist's picker roster, for a compelled Heist holder. */
  heistTargetIds: string[];
  /** Issue #470: shown in the cast form (Last Drip's fall-through). */
  castNotice?: string | null;
}) {
  if (!compelled && waitingOnNames.length === 0) return null;

  return (
    <section className="w-full max-w-sm">
      <CardFrame title="Brewmageddon!">
        {compelled ? (
          <>
            <p className="font-body text-sm text-parchment">
              {brewmageddonCasterName} played Brewmageddon: you must play{" "}
              <strong className="text-gilt-bright">{compelled.cardName}</strong>{" "}
              {compelled.castingTime === "A"
                ? "now. Nobody rolls until every compelled card is in."
                : "in the reaction window once the rolls are in. You can't pass it."}
            </p>
            {compelled.castingTime === "A" && held ? (
              held.effectKind === "dispel" ? (
                <DispelForm roundId={roundId} cardName={held.cardName} dispellableEffects={dispellableEffects} />
              ) : (
                <CastForm
                  roundId={roundId}
                  held={held}
                  participants={participants}
                  selfPlayerId={selfPlayerId}
                  heistTargetIds={heistTargetIds}
                  compelled
                  castNotice={castNotice}
                />
              )
            ) : null}
          </>
        ) : (
          <p className="font-body text-sm text-parchment-dim">
            Rolling opens once {joinNames(waitingOnNames, "")} play their card.
          </p>
        )}
      </CardFrame>
    </section>
  );
}
