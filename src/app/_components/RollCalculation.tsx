import type { CSSProperties } from "react";
import { classifyRollCalculation, getModifierJitterIntensity } from "@/lib/game/rollCalculation";
import { DieIcon } from "@/app/_components/DieIcon";
import type {
  RollCalculationDiceTerm,
  RollCalculationEffectBadge,
  RollCalculationModifierTerm,
} from "@/lib/game/rollCalculationEffects";

export type { RollCalculationDiceTerm, RollCalculationEffectBadge, RollCalculationModifierTerm };

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
 * `discardedRoll`/`diceTerms`/`effects`/`modifierTerms` are ignored unless
 * `rich` is set.
 *
 * `modifierTerms` (issue #243) breaks the modifier into its individually
 * labeled parts (persistent modifier + each spell effect's own marginal
 * contribution) instead of showing `modifier` as one collapsed number —
 * omit it (RoundReveal's reroll-chain rows do, having no per-effect detail
 * to break down) to fall back to today's single unlabeled term.
 */
export function RollCalculation({
  roll,
  modifier,
  rich = false,
  discardedRoll = null,
  diceTerms = [],
  effects = [],
  modifierTerms,
}: {
  roll: number;
  modifier: number;
  rich?: boolean;
  discardedRoll?: number | null;
  diceTerms?: RollCalculationDiceTerm[];
  effects?: RollCalculationEffectBadge[];
  modifierTerms?: RollCalculationModifierTerm[];
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

  const jitter = getModifierJitterIntensity(calc.modifier);
  // Falls back to today's single unlabeled term (the whole modifier) when
  // the caller has no per-effect breakdown to offer — see the doc comment
  // above on `modifierTerms`. The fallback term's `label: null` is the one
  // case an individual term goes unlabeled, hence the wider `DisplayTerm`
  // type below rather than reusing `RollCalculationModifierTerm` verbatim.
  const terms: DisplayTerm[] = modifierTerms ?? [{ label: null, value: calc.modifier }];

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="flex flex-wrap items-center justify-end gap-1 whitespace-nowrap font-mono text-sm text-parchment-dim">
        <DieIcon shape="d20" value={calc.roll} className="h-5 w-5" />
        {discardedRoll !== null ? (
          <span className="text-parchment-dim/60 line-through">{discardedRoll}</span>
        ) : null}
        <ModifierTerms terms={terms} jitter={jitter} />
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

/** Shake amplitude at the lowest (floor) and highest (capped) jitter intensity, in px. */
const JITTER_MIN_AMPLITUDE_PX = 1;
const JITTER_MAX_AMPLITUDE_PX = 3;
/** Shake period at the lowest and highest jitter intensity, in seconds — faster as intensity rises. */
const JITTER_MAX_PERIOD_SECONDS = 0.5;
const JITTER_MIN_PERIOD_SECONDS = 0.25;

/**
 * The modifier terms of the calc line ("+ 0[mod] + 1[LUCKY SIP] - 2
 * [CALAMI-TEA]", issue #243), wrapped in one element so the issue #196
 * "danger" jitter can target the whole group without disturbing the roll or
 * total — the acceptance criteria is explicit that those two must stay
 * legible regardless of how high the modifier climbs. Jitter keys off the
 * combined value the caller passed to `getModifierJitterIntensity`, same as
 * before #243 split the modifier into terms — which term(s) the shake
 * visually touches isn't load-bearing, only that a high modifier still cues
 * danger somewhere in the line.
 *
 * `jitter` is the 0-1 intensity from `getModifierJitterIntensity` — 0 (below
 * +8) renders today's static text; anything above scales both the shake's
 * amplitude and its speed via CSS custom properties consumed by the
 * `modifier-jitter` keyframes in globals.css. Only the motion signals
 * "danger" here, deliberately — the issue asks for a jitter cue, not an
 * additional color change layered on top.
 */
/** A modifier term as actually rendered — `RollCalculationModifierTerm`
 * widened to allow the unlabeled legacy fallback (see `terms` above). */
type DisplayTerm = { label: string | null; value: number };

function ModifierTerms({ terms, jitter }: { terms: DisplayTerm[]; jitter: number }) {
  const content = terms.map((term, i) => {
    const operator = term.value >= 0 ? "+" : "-";
    return (
      <span key={i} className="inline-flex items-baseline gap-0.5">
        {operator} {Math.abs(term.value)}
        {term.label ? (
          <span className="text-[9px] uppercase tracking-wide text-parchment-dim/70">[{term.label}]</span>
        ) : null}
      </span>
    );
  });

  if (jitter <= 0) {
    return <span className="inline-flex flex-wrap items-baseline gap-1">{content}</span>;
  }

  const amplitude = JITTER_MIN_AMPLITUDE_PX + jitter * (JITTER_MAX_AMPLITUDE_PX - JITTER_MIN_AMPLITUDE_PX);
  const period = JITTER_MAX_PERIOD_SECONDS - jitter * (JITTER_MAX_PERIOD_SECONDS - JITTER_MIN_PERIOD_SECONDS);

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
      {content}
    </span>
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
