import { describe, expect, it } from "vitest";
import { composeModifier, type ModifierEffect } from "./modifierBucket";

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
