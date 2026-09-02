import { classifyRollCalculation } from "@/lib/game/rollCalculation";
import type { RerollChainLevel } from "@/lib/game/rerollChain";
import { RollCalculation } from "@/app/_components/RollCalculation";

// Progressively deeper left margins for each nested reroll level, so a chained
// tie visibly steps in. A chain nesting deeper than this list is vanishingly
// rare (the same tied subset rerolled and tied again that many times in a
// row); falls back to the deepest defined indent rather than stop indenting.
const REROLL_INDENT_CLASSES = ["ml-5", "ml-10", "ml-14", "ml-20", "ml-24"];
function rerollIndentClass(chainIndex: number): string {
  return REROLL_INDENT_CLASSES[chainIndex] ?? REROLL_INDENT_CLASSES[REROLL_INDENT_CLASSES.length - 1] ?? "ml-5";
}

/**
 * The nested dependent rows under one player's layer-0 row (issue #220): every
 * tie-break reroll layer that player was tied into, in order, each with its own
 * roll + modifier calculation and running total. Shared by RoundReveal's live
 * roster and the scrapped generation-0 disclosure (issue #352) so both render
 * a chained tie identically.
 *
 * A reroll layer never carries a discarded die or effect badge (issue #219
 * exempted tie-break rerolls from advantage/disadvantage and from spells), so
 * the total is always a plain roll+modifier sum, or the bare roll for a
 * nat-1/nat-20 — the same rule classifyRollCalculation applies to layer 0.
 */
export function RerollChainRows({ chain }: { chain: RerollChainLevel[] }) {
  return (
    <>
      {chain.map((level, i) => {
        const levelCalc = classifyRollCalculation(level.roll, level.modifier);
        const levelBadgeValue = levelCalc.kind === "sum" ? levelCalc.total : level.roll;

        return (
          <div
            key={level.layer}
            className={`mt-1.5 flex items-center justify-between gap-3 border-l-2 border-dashed border-gilt-dark py-1.5 pl-3 ${rerollIndentClass(i)}`}
          >
            <span className="font-body text-[10px] uppercase tracking-widest text-parchment-dim">
              Reroll {i + 1}
              {level.tied ? (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-ember-bright bg-ember/25 px-2 py-0.5 text-[10px] normal-case tracking-normal text-parchment">
                  Tied again
                </span>
              ) : null}
            </span>
            <div className="flex items-center gap-2">
              <RollCalculation roll={level.roll} modifier={level.modifier} rich discardedRoll={null} />
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border-2 border-gilt bg-tavern-panel-dark font-display text-xs text-parchment">
                {levelBadgeValue}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
