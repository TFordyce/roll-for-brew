import { classifyEffectImpact, composeModifier, type ImpactEffect, type ModifierEffect } from "@/lib/game/modifierBucket";
import { parseDieShape, type DieShape } from "@/lib/game/dieShape";
import type { ModifierEffectDetail } from "@/lib/supabase/spellCasts";

export type RollCalculationEffectBadge = {
  cardName: string;
  casterName: string;
  impact: "boon" | "bust";
};

export type RollCalculationDiceTerm = {
  shape: DieShape;
  value: number;
};

export type BuiltRollCalculation = {
  /** The true round modifier — persistentModifier composed with every
   * composable effect below, matching what the server actually resolved
   * the layer with (layerResolution.ts's own composeModifier call). Neither
   * getRoundModifierEffects nor getRoundModifierEffectDetails precomputes
   * this for display, so RollCalculation's rich mode needs it recomputed
   * client-side. */
  composedModifier: number;
  diceTerms: RollCalculationDiceTerm[];
  effects: RollCalculationEffectBadge[];
};

function toImpactEffect(detail: ModifierEffectDetail): ImpactEffect {
  switch (detail.effectKind) {
    case "advantage":
      return { kind: "advantage" };
    case "disadvantage":
      return { kind: "disadvantage" };
    case "dice_modifier":
      return { kind: "dice_modifier", delta: detail.resolvedValue ?? 0 };
    case "flat_modifier":
      return { kind: "flat_modifier", delta: detail.effectParams.delta ?? 0 };
    case "modifier_multiplier":
      return { kind: "modifier_multiplier", multiplier: detail.effectParams.multiplier ?? 1 };
    case "set_modifier":
      return { kind: "set_modifier", value: detail.effectParams.value ?? 0 };
  }
}

// Same conversion classifyEffectImpact uses internally (modifierBucket.ts's
// private toComposable) — duplicated here rather than exported from there,
// since composeModifier's contract/callers are explicitly not to change
// for issue #166; this module owns its own display-only composition.
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
 * Builds RollCalculation's rich-mode props for one player from this round's
 * per-effect detail rows — already in ordinal order (migration 0051) —
 * feeding classifyEffectImpact (issue #166) for the boon/bust call on each
 * effect, and composeModifier for the true round-modifier total.
 * `casterName` resolves a caster's player id to a display name; callers
 * typically back this with the round's participant roster.
 */
export function buildRollCalculation(
  persistentModifier: number,
  effectsForPlayer: ModifierEffectDetail[],
  casterName: (playerId: string) => string,
): BuiltRollCalculation {
  const impactEffects = effectsForPlayer.map(toImpactEffect);
  const impacts = classifyEffectImpact(persistentModifier, impactEffects);
  const composableEffects = impactEffects
    .map(toModifierEffect)
    .filter((e): e is ModifierEffect => e !== null);

  const diceTerms: RollCalculationDiceTerm[] = [];
  effectsForPlayer.forEach((detail) => {
    if (detail.effectKind !== "dice_modifier" || detail.resolvedValue === null) return;
    const shape = detail.effectParams.dice ? parseDieShape(detail.effectParams.dice) : null;
    if (shape) diceTerms.push({ shape, value: detail.resolvedValue });
  });

  const effects: RollCalculationEffectBadge[] = effectsForPlayer.map((detail, i) => ({
    cardName: detail.cardName,
    casterName: casterName(detail.casterPlayerId),
    impact: impacts[i]!,
  }));

  return {
    composedModifier: composeModifier(persistentModifier, composableEffects),
    diceTerms,
    effects,
  };
}
