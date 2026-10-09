import type { RerollChainLevel } from "@/lib/game/roundRecap";
import { RollCalculation } from "@/app/_components/RollCalculation";

const REROLL_INDENT_CLASSES = ["ml-5", "ml-10", "ml-14", "ml-20", "ml-24"];
function rerollIndentClass(chainIndex: number): string {
  return REROLL_INDENT_CLASSES[chainIndex] ?? REROLL_INDENT_CLASSES[REROLL_INDENT_CLASSES.length - 1] ?? "ml-5";
}

export function RerollChainRows({ chain }: { chain: RerollChainLevel[] }) {
  return (
    <>
      {chain.map((level, i) => {
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
                {level.badgeValue}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
