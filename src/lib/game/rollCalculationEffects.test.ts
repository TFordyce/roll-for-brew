import { describe, expect, it } from "vitest";
import { buildRollCalculation } from "./rollCalculationEffects";
import type { ModifierEffectDetail } from "@/lib/supabase/spellCasts";

function detail(overrides: Partial<ModifierEffectDetail>): ModifierEffectDetail {
  return {
    targetPlayerId: "target-1",
    effectKind: "flat_modifier",
    effectParams: {},
    resolvedValue: null,
    cardName: "Lucky Sip",
    casterPlayerId: "caster-1",
    ...overrides,
  };
}

const casterName = (playerId: string) => (playerId === "caster-1" ? "Alice" : playerId);

describe("buildRollCalculation", () => {
  it("returns the persistent modifier untouched with no effects", () => {
    const built = buildRollCalculation(4, [], casterName);
    expect(built).toEqual({ composedModifier: 4, diceTerms: [], effects: [] });
  });

  it("composes a flat_modifier boon and labels its badge", () => {
    const effects = [detail({ effectKind: "flat_modifier", effectParams: { delta: 3 } })];
    const built = buildRollCalculation(4, effects, casterName);
    expect(built.composedModifier).toBe(7);
    expect(built.effects).toEqual([{ cardName: "Lucky Sip", casterName: "Alice", impact: "boon" }]);
  });

  it("extracts a dice_modifier term as a decorative die icon without double-counting it in composedModifier", () => {
    const effects = [
      detail({
        effectKind: "dice_modifier",
        effectParams: { dice: "1d6" },
        resolvedValue: 5,
        cardName: "Six Sugars",
      }),
    ];
    const built = buildRollCalculation(4, effects, casterName);
    // 4 (persistent) + 5 (the resolved die) = 9 — composed exactly once,
    // the die icon is decorative labelling only (gap 2's resolution).
    expect(built.composedModifier).toBe(9);
    expect(built.diceTerms).toEqual([{ shape: "d6", value: 5 }]);
    expect(built.effects).toEqual([{ cardName: "Six Sugars", casterName: "Alice", impact: "boon" }]);
  });

  it("classifies a multiplier that worsens a negative modifier as a bust badge", () => {
    const effects = [detail({ effectKind: "modifier_multiplier", effectParams: { multiplier: 2 } })];
    const built = buildRollCalculation(-4, effects, casterName);
    expect(built.composedModifier).toBe(-8);
    expect(built.effects[0]!.impact).toBe("bust");
  });

  it("labels advantage/disadvantage badges without touching composedModifier", () => {
    const effects = [
      detail({ effectKind: "advantage", cardName: "Six Sugars" }),
      detail({ effectKind: "disadvantage", cardName: "Mug Shot" }),
    ];
    const built = buildRollCalculation(4, effects, casterName);
    expect(built.composedModifier).toBe(4);
    expect(built.effects.map((e) => e.impact)).toEqual(["boon", "bust"]);
  });

  it("a set_modifier badge reflects whether it helped or hurt relative to what it replaced", () => {
    const effects = [detail({ effectKind: "set_modifier", effectParams: { value: 0 } })];
    const helpful = buildRollCalculation(-10, effects, casterName);
    expect(helpful.composedModifier).toBe(0);
    expect(helpful.effects[0]!.impact).toBe("boon");

    const harmful = buildRollCalculation(10, effects, casterName);
    expect(harmful.composedModifier).toBe(0);
    expect(harmful.effects[0]!.impact).toBe("bust");
  });

  it("resolves an unrecognized dice string by skipping the icon, not throwing", () => {
    const effects = [
      detail({ effectKind: "dice_modifier", effectParams: { dice: "1d100" }, resolvedValue: 42 }),
    ];
    const built = buildRollCalculation(0, effects, casterName);
    expect(built.diceTerms).toEqual([]);
    expect(built.composedModifier).toBe(42);
  });

  it("falls back to the raw player id when the caster can't be resolved to a display name", () => {
    const effects = [detail({ casterPlayerId: "unknown-player" })];
    const built = buildRollCalculation(0, effects, casterName);
    expect(built.effects[0]!.casterName).toBe("unknown-player");
  });
});
