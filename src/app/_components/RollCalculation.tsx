import { classifyRollCalculation } from "@/lib/game/rollCalculation";

/**
 * Renders the roll+modifier calculation that actually decides a layer
 * (issue #99) — e.g. "2 + 2 = 4" — instead of leaving the roll and modifier
 * as two disconnected values a player has to add up themselves. Nat-1/nat-20
 * rolls (issue #5) stay visually distinct badges rather than a sum, since
 * resolveLayer never adds their modifier into a total for either case.
 */
export function RollCalculation({ roll, modifier }: { roll: number; modifier: number }) {
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

  return (
    <span className="whitespace-nowrap font-mono text-xs text-parchment-dim">
      {calc.roll} {operator} {Math.abs(calc.modifier)} = <span className="text-parchment">{calc.total}</span>
    </span>
  );
}
