import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { joinNames } from "@/lib/game/displayName";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";

export function TieRollModal({
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
    <div
      role="dialog"
      aria-label="Tie-break reroll"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-5"
    >
      <div className="w-full max-w-[320px] rounded-lg border-4 border-gilt bg-tavern-panel p-5 text-center shadow-[0_0_0_1px_theme(colors.gilt.dark),0_12px_32px_rgb(0_0_0_/_0.6)]">
        {ownRoll === null ? (
          <>
            <h2 className="mb-1 font-display text-sm uppercase tracking-widest text-gilt-bright">Tied!</h2>
            <p className="mb-1 font-body text-xs leading-relaxed text-parchment-dim">
              You&rsquo;re tied with {othersLabel}. Roll again to break the tie.
            </p>
            {rollInputMode ? <RollInputPicker mode={rollInputMode} roundId={roundId} /> : null}
          </>
        ) : (
          <>
            <h2 className="mb-1 font-display text-sm uppercase tracking-widest text-gilt-bright">Rolled!</h2>
            <p className="font-body text-xs leading-relaxed text-parchment-dim">
              Waiting for {othersLabel} to roll &mdash; the row updates once you&rsquo;re both in.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
