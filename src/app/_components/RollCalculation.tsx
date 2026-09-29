import type { CSSProperties, ReactNode } from "react";
import { classifyRollCalculation, getModifierJitterIntensity } from "@/lib/game/rollCalculation";
import { DieIcon } from "@/app/_components/DieIcon";

/**
 * Renders a bare roll + modifier calculation (issue #99) — e.g. "2 + 2 = 4" —
 * instead of leaving the roll and modifier as two disconnected values.
 * Nat-1/nat-20 rolls (issue #5) stay visually distinct badges rather than a
 * sum.
 *
 * Used where there is no resolver row to render: PlayerTile's plain form, and
 * the tie-break reroll levels (`rich`, with a d20 icon and the issue #196
 * jitter), where layers > 0 carry no spell logic (ADR 0007). The layer-0 roll
 * row renders the resolver's own output through RollRowExpression instead.
 */
export function RollCalculation({
  roll,
  modifier,
  rich = false,
  discardedRoll = null,
}: {
  roll: number;
  modifier: number;
  rich?: boolean;
  discardedRoll?: number | null;
}) {
  const calc = classifyRollCalculation(roll, modifier);

  if (calc.kind === "nat1") {
    return (
      <span className="font-display text-xs font-semibold uppercase tracking-widest text-red-500">
        Nat 1
      </span>
    );
  }

  if (calc.kind === "nat20") {
    return (
      <span className="font-display text-xs font-semibold uppercase tracking-widest text-gilt-bright">
        Nat 20
      </span>
    );
  }

  // Spaced-operator form ("2 + 2 = 4"), distinct from the compact "+2"/"-2"
  // badge format used elsewhere — this reads as an arithmetic expression,
  // not a standalone modifier label.
  const operator = calc.modifier >= 0 ? "+" : "-";

  if (!rich) {
    return (
      <span className="whitespace-nowrap font-mono text-xs text-parchment-dim">
        {calc.roll} {operator} {Math.abs(calc.modifier)} = <span className="text-parchment">{calc.total}</span>
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center justify-end gap-1 whitespace-nowrap font-mono text-sm text-parchment-dim">
      <DieIcon shape="d20" value={calc.roll} className="h-5 w-5" />
      {discardedRoll !== null ? <span className="text-parchment-dim/60 line-through">{discardedRoll}</span> : null}
      <ModifierJitter intensity={getModifierJitterIntensity(calc.modifier)}>
        {operator} {Math.abs(calc.modifier)}
      </ModifierJitter>
      {" = "}
      <span className="text-base font-semibold text-parchment">{calc.total}</span>
    </span>
  );
}

/** Shake amplitude at the lowest (floor) and highest (capped) jitter intensity, in px. */
const JITTER_MIN_AMPLITUDE_PX = 1;
const JITTER_MAX_AMPLITUDE_PX = 3;
/** Shake period at the lowest and highest jitter intensity, in seconds — faster as intensity rises. */
const JITTER_MAX_PERIOD_SECONDS = 0.5;
const JITTER_MIN_PERIOD_SECONDS = 0.25;

/**
 * The issue #196 "danger" jitter on a calc line's modifier term(s), wrapped in
 * one element so the shake never disturbs the roll or the total — the
 * acceptance criteria is explicit that those two must stay legible however
 * high the modifier climbs.
 *
 * `intensity` is the 0-1 value from `getModifierJitterIntensity` — 0 (below
 * +8) renders static text; anything above scales both the shake's amplitude
 * and its speed via CSS custom properties consumed by the `modifier-jitter`
 * keyframes in globals.css. Only the motion signals "danger", deliberately —
 * no additional color change layered on top.
 */
export function ModifierJitter({ intensity, children }: { intensity: number; children: ReactNode }) {
  if (intensity <= 0) {
    return <span className="inline-flex flex-wrap items-baseline gap-1">{children}</span>;
  }

  const amplitude = JITTER_MIN_AMPLITUDE_PX + intensity * (JITTER_MAX_AMPLITUDE_PX - JITTER_MIN_AMPLITUDE_PX);
  const period = JITTER_MAX_PERIOD_SECONDS - intensity * (JITTER_MAX_PERIOD_SECONDS - JITTER_MIN_PERIOD_SECONDS);

  return (
    <span
      className="inline-flex flex-wrap items-baseline gap-1"
      style={
        {
          animation: `modifier-jitter ${period}s ease-in-out infinite`,
          "--jitter-amplitude": `${amplitude}px`,
        } as CSSProperties
      }
    >
      {children}
    </span>
  );
}
