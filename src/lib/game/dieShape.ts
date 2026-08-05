/**
 * The die shapes RollCalculation's rich mode can render an icon for (issue
 * #167) — kept separate from the DieIcon component (a pure/rendering split)
 * so parseDieShape stays unit-testable without React/DOM.
 */
export type DieShape = "d4" | "d6" | "d20";

/**
 * Maps a dice-effect's `effect_params.dice` string (e.g. "1d6") to the
 * DieShape DieIcon needs. Only d4/d6 appear in the catalog today; returns
 * null for anything unrecognized so callers can skip the icon rather than
 * render a wrong one.
 */
export function parseDieShape(dice: string): DieShape | null {
  const match = /d(\d+)$/.exec(dice);
  if (!match) return null;
  const sides = `d${match[1]}`;
  return sides === "d4" || sides === "d6" || sides === "d20" ? sides : null;
}
