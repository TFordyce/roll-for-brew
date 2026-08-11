import type { RollInputMode } from "@/lib/supabase/playerSettings";
import type { PendingSpellDie } from "@/lib/supabase/spellCasts";
import { CardFrame } from "@/app/_components/CardFrame";
import { InAppSpellDieForm, ManualSpellDieForm } from "@/app/rounds/SpellDieForms";
import { SpellDieBothPicker } from "@/app/rounds/SpellDieBothPicker";

/**
 * The "roll your card's die" prompt (issue #252) — shown for each of the
 * caller's own dice_modifier casts still awaiting a value (Six Sugars/Cold
 * Tea/Slipped Spoon today), offering the same in-app/manual/both choice the
 * main d20 roll already offers via roll_input_mode (RollInputPicker.tsx).
 * Rendered unconditionally once cast (round can be either 'open', for a
 * pre-roll Action cast, or 'closed', for a Reaction cast made mid-window) —
 * unlike SpellDrawChoicePanel, there's no Spell Draw Window-style gate here:
 * the round's own layer-0 resolution is already blocked on this being
 * resolved (get_current_layer_rolls_if_complete's gate, migration 0069), so
 * showing the prompt as soon as it exists is the whole point.
 */
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
