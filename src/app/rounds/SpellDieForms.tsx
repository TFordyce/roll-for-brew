import { resolvePendingSpellDieInAppAction } from "@/app/rounds/actions";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { parseDiceRange } from "@/lib/game/dieShape";
import { PendingSpellDieManualForm } from "@/app/rounds/PendingSpellDieManualForm";

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

export function ManualSpellDieForm({ roundId, castId, dice }: { roundId: string; castId: string; dice: string }) {
  const range = parseDiceRange(dice);

  return <PendingSpellDieManualForm roundId={roundId} castId={castId} min={range?.min ?? 1} max={range?.max ?? 20} />;
}
