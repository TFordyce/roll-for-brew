import type { CSSProperties, ReactNode } from "react";
import { classifyRollCalculation, getModifierJitterIntensity } from "@/lib/game/rollCalculation";
import { DieIcon } from "@/app/_components/DieIcon";

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

const JITTER_MIN_AMPLITUDE_PX = 1;
const JITTER_MAX_AMPLITUDE_PX = 3;
const JITTER_MAX_PERIOD_SECONDS = 0.5;
const JITTER_MIN_PERIOD_SECONDS = 0.25;

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
