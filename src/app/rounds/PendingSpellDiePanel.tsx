import type { RollInputMode } from "@/lib/supabase/playerSettings";
import type { PendingSpellDie } from "@/lib/supabase/spellCasts";
import { CardFrame } from "@/app/_components/CardFrame";
import { InAppSpellDieForm, ManualSpellDieForm } from "@/app/rounds/SpellDieForms";
import { SpellDieBothPicker } from "@/app/rounds/SpellDieBothPicker";

export function PendingSpellDiePanel({
  roundId,
  pendingDice,
  rollInputMode,
}: {
  roundId: string;
  pendingDice: PendingSpellDie[];
  rollInputMode: RollInputMode;
}) {
  if (pendingDice.length === 0) return null;

  return (
    <>
      {pendingDice.map((pending) => (
        <section key={pending.castId} className="w-full max-w-sm">
          <CardFrame title="Roll Your Die">
            <p className="font-body text-sm text-parchment">
              <strong className="text-gilt-bright">{pending.cardName}</strong> adds {pending.dice} to your roll —
              roll it now.
            </p>

            {rollInputMode === "in_app_only" ? (
              <InAppSpellDieForm roundId={roundId} castId={pending.castId} />
            ) : rollInputMode === "manual_only" ? (
              <ManualSpellDieForm roundId={roundId} castId={pending.castId} dice={pending.dice} />
            ) : (
              <SpellDieBothPicker key={pending.castId} roundId={roundId} castId={pending.castId} dice={pending.dice} />
            )}
          </CardFrame>
        </section>
      ))}
    </>
  );
}
