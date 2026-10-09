"use client";

import { buildScrappedGenerationRecap } from "@/lib/game/roundRecap";
import type { ScrappedGeneration } from "@/lib/supabase/roundRecap";
import { RollRowExpression } from "@/app/_components/RollRowExpression";
import { RoundRecap } from "@/app/_components/RoundRecap";
import { RerollChainRows } from "@/app/_components/RerollChainRows";
import { ProxyBadge } from "@/app/_components/ProxyBadge";

export function ScrappedGenerationDisclosure({
  generations,
  roster,
  displayName,
}: {
  generations: ScrappedGeneration[];
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
                      return (
                        <li key={row.playerId} className="py-1.5">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-1 flex-col gap-y-0.5 sm:flex-row sm:items-center sm:gap-x-2">
                              <span className="font-body text-sm text-parchment">{displayName(row.playerId)}</span>
                              {row.row.enteredByAdmin ? <ProxyBadge /> : null}
                              <RollRowExpression row={row.row} />
                            </div>
                            <span
                              className={`flex h-8 w-8 items-center justify-center rounded-md border-2 font-display text-sm ${
                                row.isBrewer
                                  ? "border-gilt-bright bg-ember text-parchment"
                                  : "border-gilt bg-tavern-panel-dark text-parchment"
                              }`}
                            >
                              {row.row.badgeValue ?? "—"}
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
