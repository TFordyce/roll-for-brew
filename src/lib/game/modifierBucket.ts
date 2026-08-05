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

/**
 * A round-modifier effect in the shape classifyEffectImpact needs to judge
 * it, one step wider than ModifierEffect: dice_modifier/advantage/
 * disadvantage aren't composable kinds in composeModifier (dice_modifier is
 * already folded into a flat delta by the caller — see spellCasts.ts's
 * toModifierEffect — and advantage/disadvantage never touch the numeric
 * modifier at all), but classifyEffectImpact still needs to tell them apart
 * from flat_modifier/modifier_multiplier/set_modifier to know which rule to
 * apply (issue #166).
 */
export type ImpactEffect =
  | { kind: "advantage" }
  | { kind: "disadvantage" }
  | { kind: "dice_modifier"; delta: number }
  | { kind: "flat_modifier"; delta: number }
  | { kind: "modifier_multiplier"; multiplier: number }
  | { kind: "set_modifier"; value: number };

export type EffectImpact = "boon" | "bust";

function toModifierEffect(effect: ImpactEffect): ModifierEffect | null {
  switch (effect.kind) {
    case "dice_modifier":
    case "flat_modifier":
      return { kind: "flat", delta: effect.delta };
    case "modifier_multiplier":
      return { kind: "multiplier", multiplier: effect.multiplier };
    case "set_modifier":
      return { kind: "set", value: effect.value };
    default:
      return null;
  }
}

/**
 * Classifies each effect in `effects` (already in ordinal order) as a
 * "boon" (helped the target this round) or a "bust" (hurt them).
 *
 * dice_modifier and advantage are always a boon, and disadvantage is
 * always a bust — no catalog card applies a negative dice effect or a
 * disadvantageous "advantage", so these need no computation.
 *
 * flat_modifier/modifier_multiplier/set_modifier are context-dependent: a
 * multiplier can worsen a negative modifier, and a set overrides whatever
 * it replaced. For these, classification is a marginal before/after diff —
 * composeModifier is evaluated once over everything up to and including
 * this effect in ordinal order, and once over that same prefix with just
 * this effect excluded. The sign of the difference is this effect's own
 * boon/bust call, independent of how the rest of the stack nets out.
 */
function toComposable(effects: ImpactEffect[]): ModifierEffect[] {
  return effects.map(toModifierEffect).filter((e): e is ModifierEffect => e !== null);
}

export function classifyEffectImpact(
  persistentModifier: number,
  effects: ImpactEffect[],
): EffectImpact[] {
  return effects.map((effect, index) => {
    if (effect.kind === "disadvantage") return "bust";
    if (effect.kind === "advantage" || effect.kind === "dice_modifier") return "boon";

    const prefix = effects.slice(0, index + 1);
    const withEffect = composeModifier(persistentModifier, toComposable(prefix));
    const withoutEffect = composeModifier(
      persistentModifier,
      toComposable(prefix.filter((_, i) => i !== index)),
    );

    // A no-op (zero marginal diff) resolves in the target's favor rather
    // than being penalized as a bust.
    return withEffect >= withoutEffect ? "boon" : "bust";
  });
}
