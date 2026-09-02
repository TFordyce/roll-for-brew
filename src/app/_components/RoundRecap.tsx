"use client";

import { useState } from "react";
import type { CastChip, CastState, RecapStep, RoundRecapModel } from "@/lib/game/roundRecap";

/**
 * The Round Recap — "the Ledger" (issue #314). Renders the pure model from
 * buildRoundRecap: a tap-to-filter cast strip on top, then a flat,
 * phase-grouped list of step rows in resolution order. Owns no wording — every
 * sentence comes from the model.
 *
 * The DOM id `recap-player-<playerId>` on the first step touching a player is
 * the scroll target for RoundReveal's per-tile calc rows (scrollToRecapPlayer).
 */

export function scrollToRecapPlayer(playerId: string) {
  const el = document.getElementById(`recap-player-${playerId}`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
}

const STATE_STYLES: Record<CastState | "pending", string> = {
  armed: "border-gilt-dark text-parchment-dim",
  "on-stack": "border-gilt-bright text-gilt-bright",
  pending: "border-gilt-bright text-gilt-bright",
  applied: "border-[#f5c542] text-[#f5c542]",
  negated: "border-[#e0433f] text-[#e0433f] line-through",
  redirected: "border-[#6fb0d8] text-[#6fb0d8]",
  blocked: "border-[#6fb0d8] text-[#6fb0d8]",
  backfired: "border-[#e0433f] text-[#e0433f]",
  "no-op": "border-gilt-dark text-parchment-dim",
};

function CastStrip({
  chips,
  activeCast,
  onToggle,
}: {
  chips: CastChip[];
  activeCast: string | null;
  onToggle: (castId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => {
        const dimmed = activeCast !== null && activeCast !== chip.castId;
        return (
          <button
            key={chip.castId}
            type="button"
            onClick={() => onToggle(chip.castId)}
            aria-pressed={activeCast === chip.castId}
            className={`rounded-full border px-2 py-0.5 font-body text-[11px] transition-opacity ${
              STATE_STYLES[chip.state]
            } ${dimmed ? "opacity-35" : "opacity-100"}`}
            title={`${chip.casterName} · ${chip.state.replace("-", " ")}`}
          >
            <span className="text-parchment">{chip.cardName}</span>
            <span className="ml-1 uppercase tracking-wide">{chip.state.replace("-", " ")}</span>
          </button>
        );
      })}
    </div>
  );
}

function StepRow({ step }: { step: RecapStep }) {
  const ba = step.beforeAfter;
  return (
    <div
      className={`grid grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-2 py-1 ${
        step.pending ? "animate-pulse" : ""
      }`}
    >
      <span className="font-display text-[11px] text-parchment-dim">{step.displayIndex}</span>
      <div className="min-w-0">
        <span className="font-body text-[13px] text-parchment">{step.sentence}</span>
        <span className="ml-1.5 font-display text-[9px] uppercase tracking-widest text-parchment-dim">
          {step.displayKind.replace(/_/g, " ")}
        </span>
      </div>
      <div className="flex items-center gap-1.5 justify-self-end">
        {ba && ba.label ? (
          ba.unchanged ? (
            <span className="rounded-sm border border-gilt-dark px-1 font-body text-[10px] text-parchment-dim">
              {ba.label} {ba.from} · unchanged
            </span>
          ) : (
            <span className="font-body text-[11px] text-parchment-dim">
              {ba.label} {ba.from} → <span className="text-parchment">{ba.to}</span>
            </span>
          )
        ) : null}
        <span
          className={`rounded-sm border px-1 font-display text-[9px] uppercase tracking-widest ${
            STATE_STYLES[step.statusKind]
          }`}
        >
          {step.statusLabel}
        </span>
      </div>
    </div>
  );
}

export function RoundRecap({
  model,
  anchored = true,
}: {
  model: RoundRecapModel;
  /**
   * Emit the `recap-player-<id>` scroll anchors (issue #314). Off for a
   * generation-0 disclosure Recap (issue #352), which shares the page with the
   * canonical generation-1 Recap and must not duplicate its element ids.
   */
  anchored?: boolean;
}) {
  const [activeCast, setActiveCast] = useState<string | null>(null);

  if (!model.hasContent) return null;

  const toggle = (castId: string) => setActiveCast((cur) => (cur === castId ? null : castId));

  // The first rendered step involving a given player — as target or as
  // caster — carries that player's scroll anchor (RoundReveal's calc rows
  // call scrollToRecapPlayer). A row can only carry one id; ties go to the
  // target.
  const anchoredPlayers = new Set<string>();
  function anchorFor(step: RecapStep): string | undefined {
    if (!anchored) return undefined;
    for (const playerId of [step.targetPlayer, step.casterPlayerId]) {
      if (playerId && !anchoredPlayers.has(playerId)) {
        anchoredPlayers.add(playerId);
        return `recap-player-${playerId}`;
      }
    }
    return undefined;
  }

  return (
    <section className="mb-4 rounded-md border-2 border-gilt-dark bg-tavern-panel-dark p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-display text-xs uppercase tracking-widest text-gilt-bright">Round Recap</h3>
      </div>

      <CastStrip chips={model.castStrip} activeCast={activeCast} onToggle={toggle} />

      {model.showReorderCaption ? (
        <p className="mt-2 font-body text-[10px] italic text-parchment-dim">
          Cast order → resolution order
        </p>
      ) : null}

      <div className="mt-2 divide-y divide-gilt-dark/30">
        {model.phases.map((group, groupIndex) => {
          const visible = group.steps.filter(
            (s) => activeCast === null || s.castId === activeCast,
          );
          if (visible.length === 0) return null;
          return (
            // The same label can recur (the resolver revisits the reaction
            // window), so the key is position-based, not the label.
            <div key={`${groupIndex}-${group.label}`} className="py-1.5">
              <p className="font-display text-[10px] uppercase tracking-widest text-parchment-dim">
                {group.label}
              </p>
              {visible.map((step, i) => (
                <div key={`${group.label}-${step.castId ?? "x"}-${i}`} id={anchorFor(step)}>
                  <StepRow step={step} />
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {model.endedInTieBreak ? (
        <p className="mt-2 font-body text-[11px] italic text-parchment-dim">
          Tied for lowest — no spells or reactions apply at a tie-break (#219). The recap ends here.
        </p>
      ) : null}
    </section>
  );
}
