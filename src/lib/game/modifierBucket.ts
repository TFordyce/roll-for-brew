/**
 * Composes a player's persistent room modifier with any spell-card effects
 * active on them this round into the single modifier value fed into a
 * LayerEntry (src/lib/game/resolveLayer.ts) — kept as a distinct
 * pre-processing step so resolveLayer's nat-1/nat-20 detection (which reads
 * only the raw roll) never needs to know spell cards exist (issue #67).
 *
 * Formula per the spec: (persistent_modifier × multipliers) + additive
 * deltas — except a "set" effect (e.g. Milky Brew: "target's modifier is 0
 * for this round") overrides the persistent modifier outright rather than
 * combining with it, since "set to X" and "multiply/add" aren't composable
 * in the same pass.
 */
export type ModifierEffect =
  | { kind: "flat"; delta: number }
  | { kind: "multiplier"; multiplier: number }
  | { kind: "set"; value: number };

export function composeModifier(persistentModifier: number, effects: ModifierEffect[]): number {
  const setEffect = effects.find((e) => e.kind === "set");
  if (setEffect && setEffect.kind === "set") {
    return setEffect.value;
  }

  const multiplier = effects.reduce(
    (acc, e) => (e.kind === "multiplier" ? acc * e.multiplier : acc),
    1,
  );
  const additive = effects.reduce((acc, e) => (e.kind === "flat" ? acc + e.delta : acc), 0);

  return persistentModifier * multiplier + additive;
}
