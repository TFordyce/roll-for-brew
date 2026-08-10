import { describe, expect, it } from "vitest";
import {
  classifyEffectImpact,
  composeModifier,
  composeModifierTerms,
  type ImpactEffect,
  type ModifierEffect,
} from "./modifierBucket";

describe("composeModifier", () => {
  it("returns the persistent modifier untouched with no active effects", () => {
    expect(composeModifier(4, [])).toBe(4);
  });

  it("adds a flat delta (e.g. Lucky Sip +3)", () => {
    const effects: ModifierEffect[] = [{ kind: "flat", delta: 3 }];
    expect(composeModifier(4, effects)).toBe(7);
  });

  it("sums multiple flat deltas", () => {
    const effects: ModifierEffect[] = [
      { kind: "flat", delta: 3 },
      { kind: "flat", delta: -5 },
    ];
    expect(composeModifier(10, effects)).toBe(8);
  });

  it("applies a multiplier before adding flat deltas (e.g. Double Shot)", () => {
    const effects: ModifierEffect[] = [
      { kind: "multiplier", multiplier: 2 },
      { kind: "flat", delta: 1 },
    ];
    expect(composeModifier(5, effects)).toBe(11); // (5 x 2) + 1
  });

  it("compounds multiple multipliers", () => {
    const effects: ModifierEffect[] = [
      { kind: "multiplier", multiplier: 2 },
      { kind: "multiplier", multiplier: 3 },
    ];
    expect(composeModifier(2, effects)).toBe(12); // 2 x 2 x 3
  });

  it("a set effect overrides the persistent modifier outright (e.g. Milky Brew)", () => {
    const effects: ModifierEffect[] = [{ kind: "set", value: 0 }];
    expect(composeModifier(99, effects)).toBe(0);
  });

  it("a set effect wins even alongside other effects", () => {
    const effects: ModifierEffect[] = [
      { kind: "flat", delta: 100 },
      { kind: "set", value: 0 },
    ];
    expect(composeModifier(99, effects)).toBe(0);
  });

  it("handles negative persistent modifiers the same way", () => {
    const effects: ModifierEffect[] = [{ kind: "flat", delta: 2 }];
    expect(composeModifier(-3, effects)).toBe(-1);
  });
});

describe("classifyEffectImpact", () => {
  it("classifies dice_modifier and advantage as boon, disadvantage as bust, with no computation needed", () => {
    const effects: ImpactEffect[] = [
      { kind: "dice_modifier", delta: 3 },
      { kind: "advantage" },
      { kind: "disadvantage" },
    ];
    expect(classifyEffectImpact(4, effects)).toEqual(["boon", "boon", "bust"]);
  });

  it("classifies a single boon flat_modifier", () => {
    const effects: ImpactEffect[] = [{ kind: "flat_modifier", delta: 3 }];
    expect(classifyEffectImpact(4, effects)).toEqual(["boon"]);
  });

  it("classifies a single bust flat_modifier", () => {
    const effects: ImpactEffect[] = [{ kind: "flat_modifier", delta: -3 }];
    expect(classifyEffectImpact(4, effects)).toEqual(["bust"]);
  });

  it("classifies a multiplier that worsens a negative modifier as a bust (not intrinsically good)", () => {
    const effects: ImpactEffect[] = [{ kind: "modifier_multiplier", multiplier: 2 }];
    // -4 x 2 = -8, worse than the -4 it replaced.
    expect(classifyEffectImpact(-4, effects)).toEqual(["bust"]);
  });

  it("classifies a multiplier that improves a positive modifier as a boon", () => {
    const effects: ImpactEffect[] = [{ kind: "modifier_multiplier", multiplier: 2 }];
    expect(classifyEffectImpact(4, effects)).toEqual(["boon"]);
  });

  it("classifies a set_modifier as bust when it overrides a better modifier", () => {
    const effects: ImpactEffect[] = [{ kind: "set_modifier", value: 0 }];
    // 0 is worse than the +10 persistent modifier it replaced.
    expect(classifyEffectImpact(10, effects)).toEqual(["bust"]);
  });

  it("classifies a set_modifier as boon when it overrides a worse modifier", () => {
    const effects: ImpactEffect[] = [{ kind: "set_modifier", value: 0 }];
    // 0 is better than the -10 persistent modifier it replaced.
    expect(classifyEffectImpact(-10, effects)).toEqual(["boon"]);
  });

  it("classifies a no-op effect (zero marginal diff) as boon, not bust", () => {
    // A +0 flat_modifier changes nothing, so it isn't a bust; the tie is
    // resolved in the target's favor rather than penalizing a neutral effect.
    const effects: ImpactEffect[] = [{ kind: "flat_modifier", delta: 0 }];
    expect(classifyEffectImpact(5, effects)).toEqual(["boon"]);
  });

  it("classifies each effect in a stack on its own marginal contribution, independent of the whole-stack diff", () => {
    // Persistent modifier 0, +10 then -20: the whole-stack diff (-10 vs the
    // original 0) reads as a net bust, but the first effect's own marginal
    // contribution (0 -> 10) was a boon; only the second effect (10 -> -10)
    // was the bust.
    const effects: ImpactEffect[] = [
      { kind: "flat_modifier", delta: 10 },
      { kind: "flat_modifier", delta: -20 },
    ];
    expect(classifyEffectImpact(0, effects)).toEqual(["boon", "bust"]);
  });

  it("a set_modifier later in the stack overrides earlier effects for the marginal comparison", () => {
    // The +1 flat is its own boon (99 -> 100). The set_modifier that
    // follows compares 0 (with itself included, overriding outright) against
    // 100 (the prefix without it, i.e. the +1 still applied) — a bust, even
    // though the flat before it was a boon.
    const effects: ImpactEffect[] = [
      { kind: "flat_modifier", delta: 1 },
      { kind: "set_modifier", value: 0 },
    ];
    expect(classifyEffectImpact(99, effects)).toEqual(["boon", "bust"]);
  });
});

describe("composeModifierTerms", () => {
  it("returns null for advantage/disadvantage/dice_modifier — no numeric term", () => {
    const effects: ImpactEffect[] = [
      { kind: "dice_modifier", delta: 3 },
      { kind: "advantage" },
      { kind: "disadvantage" },
    ];
    expect(composeModifierTerms(4, effects)).toEqual([null, null, null]);
  });

  it("returns a flat_modifier's own delta as its term", () => {
    const effects: ImpactEffect[] = [{ kind: "flat_modifier", delta: 3 }];
    expect(composeModifierTerms(4, effects)).toEqual([3]);
  });

  it("returns a multiplier's marginal contribution, not the raw multiplier", () => {
    const effects: ImpactEffect[] = [{ kind: "modifier_multiplier", multiplier: 2 }];
    // -4 x 2 = -8, a marginal contribution of -4 relative to the -4 it replaced.
    expect(composeModifierTerms(-4, effects)).toEqual([-4]);
  });

  it("returns a set_modifier's marginal contribution relative to what it replaced", () => {
    const effects: ImpactEffect[] = [{ kind: "set_modifier", value: 0 }];
    expect(composeModifierTerms(-10, effects)).toEqual([10]);
    expect(composeModifierTerms(10, effects)).toEqual([-10]);
  });

  it("gives each effect in a stack its own marginal term, summing to the whole-stack diff", () => {
    const effects: ImpactEffect[] = [
      { kind: "flat_modifier", delta: 10 },
      { kind: "flat_modifier", delta: -20 },
    ];
    const terms = composeModifierTerms(0, effects);
    expect(terms).toEqual([10, -20]);
    expect(terms.reduce((sum, t) => sum! + (t ?? 0), 0)).toBe(composeModifier(0, [
      { kind: "flat", delta: 10 },
      { kind: "flat", delta: -20 },
    ]));
  });
});
