import { getModifierJitterIntensity } from "@/lib/game/rollCalculation";
import type { RollRow, RollRowTerm } from "@/lib/game/roundRecap";
import { DieIcon } from "@/app/_components/DieIcon";
import { ModifierJitter } from "@/app/_components/RollCalculation";

/**
 * A player's layer-0 roll row as the resolver decided it (issue #407, ADR
 * 0007): "d20 ± mod ± [CARD] … = total", every number read straight off the
 * Round Recap module's row model (Resolution Summary + Trace terms). This
 * component does no arithmetic.
 *
 * - Applied modifier terms sit in the expression, labelled with their card.
 * - Roll-domain effects (flips, swaps, ticks, …) are chips under it: the die
 *   already shows the roll they produced.
 * - Warded / negated / redirected effects are struck-through chips, so a
 *   player sees what didn't land on them and why.
 * - A degraded row (a round resolved before Resolution Summaries existed)
 *   shows the roll, roll-time modifier and terms, but no total.
 */
export function RollRowExpression({ row }: { row: RollRow }) {
  const modifierTerms = row.terms.filter((t) => t.delta !== null);
  // A nat-1/nat-20 has no sum to hold the modifier terms, so every term —
  // applied ones included — is shown as a chip under the nat label.
  const chips = row.nat ? row.terms : row.terms.filter((t) => t.delta === null);
  const jitter = getModifierJitterIntensity(row.composed ?? row.snapshot);

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="flex flex-wrap items-center justify-end gap-1 whitespace-nowrap font-mono text-sm text-parchment-dim">
        {row.nat ? (
          <span
            className={`font-display text-xs font-semibold uppercase tracking-widest ${
              row.nat === "nat1" ? "text-red-500" : "text-gilt-bright"
            }`}
          >
            {row.nat === "nat1" ? "Nat 1" : "Nat 20"}
          </span>
        ) : (
          <>
            <DieIcon shape="d20" value={row.roll} className="h-5 w-5" />
            {row.discardedRoll !== null ? (
              <span className="text-parchment-dim/60 line-through">{row.discardedRoll}</span>
            ) : null}
            <ModifierJitter intensity={jitter}>
              <Term label="mod" value={row.snapshot} />
              {modifierTerms.map((term, i) => (
                <Term key={i} label={term.cardName ?? term.displayKind} value={term.delta!} />
              ))}
            </ModifierJitter>
            {row.total !== null ? (
              <>
                {" = "}
                <span className="text-base font-semibold text-parchment">{row.total}</span>
              </>
            ) : null}
          </>
        )}
      </span>

      {chips.length > 0 ? (
        <span className="flex flex-wrap justify-end gap-1">
          {chips.map((term, i) => (
            <TermChip key={i} term={term} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

function Term({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-0.5">
      {value >= 0 ? "+" : "-"} {Math.abs(value)}
      <span className="text-[9px] uppercase tracking-wide text-parchment-dim/70">[{label}]</span>
    </span>
  );
}

const STRUCK_LABEL: Record<NonNullable<RollRowTerm["struck"]>, string> = {
  warded: "warded",
  negated: "negated",
  redirected: "redirected",
};

function TermChip({ term }: { term: RollRowTerm }) {
  const name = term.cardName ?? term.displayKind.replace(/_/g, " ");
  const detail = term.struck
    ? STRUCK_LABEL[term.struck]
    : term.pending
      ? "die pending"
      : term.restOfDay
        ? `${term.from} → ${term.to} rest of day`
        : term.from !== null && term.to !== null
          ? `${term.from} → ${term.to}`
          : null;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
        term.struck ? "border-gilt-dark/50 text-parchment-dim/60" : "border-gilt-dark text-parchment"
      } bg-tavern-panel-dark`}
      title={term.casterName ? `${name} — ${term.casterName}` : name}
    >
      <span className={term.struck ? "line-through" : "font-semibold"}>{name}</span>
      {term.casterName ? <span className="normal-case text-parchment-dim">{term.casterName}</span> : null}
      {detail ? <span className="normal-case text-parchment-dim">{detail}</span> : null}
    </span>
  );
}
