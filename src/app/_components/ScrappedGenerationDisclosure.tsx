"use client";

import { classifyRollCalculation } from "@/lib/game/rollCalculation";
import { buildScrappedGenerationRecap } from "@/lib/game/roundRecap";
import type { ScrappedGeneration } from "@/lib/supabase/roundRecap";
import { RollCalculation } from "@/app/_components/RollCalculation";
import { RoundRecap } from "@/app/_components/RoundRecap";
import { RerollChainRows } from "@/app/_components/RerollChainRows";
import { ProxyBadge } from "@/app/_components/ProxyBadge";

/**
 * Round replay (issue #352, spec #302 §11): the canonical view is generation 1,
 * headlined normally by RoundReveal / RoundRecap. Every scrapped generation
 * before it — generation 0, the original "Time for Brew" attempt — hangs here
 * in a collapsed disclosure holding its own Round Recap (its Resolution Trace,
 * brewer, layer-0 rolls) and, if it went to a tie-break, its own nested reroll
 * rows (issue #220 rendering), kept separate from generation 1's layers.
 *
 * The scrap is a labelled boundary between two Recaps, not a Trace step. This
 * component only lays out the model from buildScrappedGenerationRecap.
 */
export function ScrappedGenerationDisclosure({
  generations,
  roster,
  displayName,
}: {
  generations: ScrappedGeneration[];
  /** Participant player ids in display order, for the layer-0 roll list. */
  roster: string[];
  displayName: (playerId: string) => string;
}) {
  if (generations.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {generations.map((gen) => {
        const model = buildScrappedGenerationRecap(gen, displayName, roster);

        return (
          <details
            key={gen.generation}
            className="rounded-md border-2 border-dashed border-gilt-dark bg-tavern-panel-dark/60"
          >
            <summary className="cursor-pointer px-3 py-2 font-display text-[11px] uppercase tracking-widest text-parchment-dim marker:text-gilt-dark">
              Scrapped first attempt — Time for Brew
              {model.brewerId ? (
                <span className="ml-2 normal-case tracking-normal text-parchment">
                  {displayName(model.brewerId)} brewed{model.cupsMade != null ? ` ${model.cupsMade}` : ""}
                  {model.brewerModifierGain ? ` · +${model.brewerModifierGain} modifier` : ""}
                </span>
              ) : null}
            </summary>

            <div className="border-t border-gilt-dark/40 p-3">
              {model.firstAttemptRolls.length > 0 ? (
                <div className="mb-3">
                  <p className="mb-1 font-display text-[10px] uppercase tracking-widest text-parchment-dim">
                    First-attempt rolls
                  </p>
                  <ul className="divide-y divide-gilt-dark/30">
                    {model.firstAttemptRolls.map((row) => {
                      const calc = classifyRollCalculation(row.value, row.modifierSnapshot);
                      const badgeValue = calc.kind === "sum" ? calc.total : row.value;

                      return (
                        <li key={row.playerId} className="py-1.5">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-1 flex-col gap-y-0.5 sm:flex-row sm:items-center sm:gap-x-2">
                              <span className="font-body text-sm text-parchment">{displayName(row.playerId)}</span>
                              {row.enteredByAdmin ? <ProxyBadge /> : null}
                              <RollCalculation
                                roll={row.value}
                                modifier={row.modifierSnapshot}
                                rich
                                discardedRoll={row.discardedValue}
                              />
                            </div>
                            <span
                              className={`flex h-8 w-8 items-center justify-center rounded-md border-2 font-display text-sm ${
                                row.isBrewer
                                  ? "border-gilt-bright bg-ember text-parchment"
                                  : "border-gilt bg-tavern-panel-dark text-parchment"
                              }`}
                            >
                              {badgeValue}
                            </span>
                          </div>
                          <RerollChainRows chain={row.rerollChain} />
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {model.recap.hasContent ? (
                <RoundRecap model={model.recap} anchored={false} />
              ) : model.wentToTieBreak ? (
                <p className="font-body text-[11px] italic text-parchment-dim">
                  Tied for lowest — settled by the reroll above. No spells were cast this attempt.
                </p>
              ) : (
                <p className="font-body text-[11px] italic text-parchment-dim">
                  No spells were cast this attempt.
                </p>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
