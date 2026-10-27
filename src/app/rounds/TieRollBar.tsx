import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { joinNames } from "@/lib/game/displayName";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";

export function TieRollBar({
  roundId,
  ownRoll,
  rollInputMode,
  otherTiedNames,
}: {
  roundId: string;
  ownRoll: number | null;
  rollInputMode: RollInputMode | null;
  otherTiedNames: string[];
}) {
  const othersLabel = joinNames(otherTiedNames, "the other tied player");

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t-4 border-gilt bg-tavern-panel p-3 shadow-[0_-8px_24px_rgb(0_0_0_/_0.5)]">
      {ownRoll === null ? (
        <>
          <p className="mb-1 font-display text-sm uppercase tracking-widest text-gilt-bright">Tied!</p>
          <p className="mb-2 font-body text-xs leading-relaxed text-parchment-dim">
            You&rsquo;re tied with {othersLabel}. Roll again to break the tie.
          </p>
          {rollInputMode ? <RollInputPicker mode={rollInputMode} roundId={roundId} /> : null}
        </>
      ) : (
        <p className="font-body text-xs leading-relaxed text-parchment-dim">
          <span className="font-display text-sm uppercase tracking-widest text-gilt-bright">Rolled! </span>
          Waiting for {othersLabel} to roll &mdash; the row updates once you&rsquo;re both in.
        </p>
      )}
    </div>
  );
}
