import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { CompelledCast, DispellableEffect } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { joinNames } from "@/lib/game/displayName";
import { CardFrame } from "@/app/_components/CardFrame";
import { CastForm, DispelForm } from "@/app/rounds/SpellCardForms";

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
  waitingOnNames: string[];
  participants: RoundParticipant[];
  selfPlayerId: string;
  dispellableEffects: DispellableEffect[];
  heistTargetIds: string[];
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
