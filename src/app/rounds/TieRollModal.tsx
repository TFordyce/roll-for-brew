import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { joinNames } from "@/lib/game/displayName";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";

/**
 * The tie-break reroll roll-in prompt (issue #220, piece 3) — replaces
 * TieBanner's previous inline `RollInputPicker` placement with a modal that
 * only the tied player still needing to roll this layer ever sees. A
 * spectator, or the other tied player, never mounts this at all — TieBanner
 * only renders it under its own existing `isTied` check, same as the
 * inline form it replaces. Matches the validated prototype's interaction
 * model (prototypes/roll-calc-tiebreak-modal-reveal.html on branch
 * worktree-prototype-tiebreak-modal-reveal, cited in issue #220).
 *
 * Two states, both driven purely by `ownRoll` — the caller's own roll for
 * the round's *current* layer (src/lib/supabase/rolls.ts's getOwnRoll,
 * readable via the "roller can read their own row" RLS policy the instant
 * *this* player submits, independent of whether the other tied player has):
 *
 *   - `ownRoll === null` — hasn't rolled yet: "Tied!" + the roll input.
 *   - `ownRoll !== null` — has rolled, but the layer hasn't moved on (the
 *     other tied player(s) haven't rolled yet — a tie is a comparison
 *     between rolls, not a fact about just one of them, so nothing can
 *     resolve until everyone's in): a "Rolled! Waiting…" state instead of
 *     a fresh prompt, so this player never sees the form again for a level
 *     they've already submitted.
 *
 * This "Rolled! Waiting…" state deliberately stays a modal rather than
 * dropping back to TieBanner's plain inline text (as the pre-#220 code did)
 * — the prototype's own reference implementation keeps this player in the
 * modal too, just switching its content, and issue #220 decision 1's "every
 * other device ... sees no modal" names *the other* tied player and
 * spectators, not this player once they've submitted. It's only "the other
 * tied player" whose device drops the modal here — never your own, whether
 * you're still rolling or already waiting on them.
 */
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
