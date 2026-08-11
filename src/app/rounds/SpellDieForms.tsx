import { resolvePendingSpellDieInAppAction } from "@/app/rounds/actions";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { parseDiceRange } from "@/lib/game/dieShape";
import { PendingSpellDieManualForm } from "@/app/rounds/PendingSpellDieManualForm";

/**
 * The in-app (server-generated) form for resolving a Pending Spell Die
 * (issue #252) — the dice_modifier counterpart to RollForms.tsx's
 * InAppRollForm, sharing its styling but posting to
 * resolvePendingSpellDieInAppAction with the cast id instead of a bare
 * roundId.
 */
export function InAppSpellDieForm({ roundId, castId }: { roundId: string; castId: string }) {
  return (
    <form action={resolvePendingSpellDieInAppAction} className="mt-3">
      <input type="hidden" name="roundId" value={roundId} />
      <input type="hidden" name="castId" value={castId} />
      <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
        Roll
      </SubmitButton>
    </form>
  );
}

/**
 * The manual-entry form for resolving a Pending Spell Die (issue #252) —
 * the dice_modifier counterpart to RollForms.tsx's ManualRollForm. `dice`
 * (e.g. "1d6") sizes the number input's min/max client-side, mirroring
 * resolve_pending_spell_die_manual's own server-side range check; a value
 * outside it surfaces as resolvePendingSpellDieManualAction's inline typed
 * error, same as any other spell-cast precondition failure.
 */
export function ManualSpellDieForm({ roundId, castId, dice }: { roundId: string; castId: string; dice: string }) {
  const range = parseDiceRange(dice);

  return <PendingSpellDieManualForm roundId={roundId} castId={castId} min={range?.min ?? 1} max={range?.max ?? 20} />;
}
