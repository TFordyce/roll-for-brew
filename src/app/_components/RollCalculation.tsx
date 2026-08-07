import { classifyRollCalculation } from "@/lib/game/rollCalculation";
import { DieIcon } from "@/app/_components/DieIcon";
import type { RollCalculationDiceTerm, RollCalculationEffectBadge } from "@/lib/game/rollCalculationEffects";

export type { RollCalculationDiceTerm, RollCalculationEffectBadge };

/**
 * Renders the roll+modifier calculation that actually decides a layer
 * (issue #99) — e.g. "2 + 2 = 4" — instead of leaving the roll and modifier
 * as two disconnected values a player has to add up themselves. Nat-1/nat-20
 * rolls (issue #5) stay visually distinct badges rather than a sum, since
 * resolveLayer never adds their modifier into a total for either case.
 *
 * `rich` opts into the issue #167 rework (dice icons, struck discarded
 * roll, animated boon/bust badges) — off by default so PlayerTile/TieBanner
 * (issue #162's narrower tie-break layout, out of #167's scope) keep
 * today's bare rendering unchanged. Only RoundReveal.tsx passes `rich`.
 * `discardedRoll`/`diceTerms`/`effects` are ignored unless `rich` is set.
 */
export function RollCalculation({
  roll,
  modifier,
  rich = false,
  discardedRoll = null,
  diceTerms = [],
  effects = [],
}: {
  roll: number;
  modifier: number;
  rich?: boolean;
  discardedRoll?: number | null;
  diceTerms?: RollCalculationDiceTerm[];
  effects?: RollCalculationEffectBadge[];
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
    <div className="flex flex-col items-end gap-1">
      <span className="flex flex-wrap items-center justify-end gap-1 whitespace-nowrap font-mono text-sm text-parchment-dim">
        <DieIcon shape="d20" value={calc.roll} className="h-5 w-5" />
        {discardedRoll !== null ? (
          <span className="text-parchment-dim/60 line-through">{discardedRoll}</span>
        ) : null}
        {operator} {Math.abs(calc.modifier)}
        {diceTerms.map((term, i) => (
          <DieIcon key={i} shape={term.shape} value={term.value} className="h-4 w-4" />
        ))}
        {" = "}
        <span className="text-base font-semibold text-parchment">{calc.total}</span>
      </span>

      {effects.length > 0 ? (
        <span className="flex flex-wrap justify-end gap-1">
          {effects.map((effect, i) => (
            <EffectBadge key={i} effect={effect} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One per-effect badge — card name (scrolling gradient + pulse/glow, gold
 * for a boon, deep red for a bust) and caster name, in a static pill.
 * Animation keyframes (badge-scroll, text-pulse-glow-boon/bust) live in
 * globals.css. background-clip: text + text-transparent paints the gradient
 * onto the glyphs themselves rather than a background box — only the card-
 * name text animates, the pill's own border/background stay static.
 */
function EffectBadge({ effect }: { effect: RollCalculationEffectBadge }) {
  const boon = effect.impact === "boon";

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-gilt-dark bg-tavern-panel-dark px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
      <span
        className={`[-webkit-background-clip:text] [background-clip:text] [background-size:200%_100%] font-semibold text-transparent ${
          boon
            ? "[background-image:linear-gradient(110deg,#f5c542,#fff2b8,#f5c542)]"
            : "[background-image:linear-gradient(110deg,#7f1414,#e0433f,#7f1414)]"
        }`}
        style={{
          animation: `badge-scroll 2.5s ease-in-out infinite alternate, ${
            boon ? "text-pulse-glow-boon" : "text-pulse-glow-bust"
          } 1.8s ease-in-out infinite`,
        }}
      >
        {effect.cardName}
      </span>
      <span className="normal-case text-parchment-dim">{effect.casterName}</span>
    </span>
  );
}
