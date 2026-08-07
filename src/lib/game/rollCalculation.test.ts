import { describe, expect, it } from "vitest";
import { classifyRollCalculation, getModifierJitterIntensity } from "./rollCalculation";

describe("classifyRollCalculation", () => {
  it("sums a plain roll and its modifier", () => {
    expect(classifyRollCalculation(2, 2)).toEqual({ kind: "sum", roll: 2, modifier: 2, total: 4 });
  });

  it("sums correctly with a negative modifier", () => {
    expect(classifyRollCalculation(5, -1)).toEqual({ kind: "sum", roll: 5, modifier: -1, total: 4 });
  });

  it("classifies a roll of 1 as nat1 regardless of modifier", () => {
    expect(classifyRollCalculation(1, 99)).toEqual({ kind: "nat1" });
  });

  it("classifies a roll of 20 as nat20 regardless of modifier", () => {
    expect(classifyRollCalculation(20, -50)).toEqual({ kind: "nat20" });
  });
});

describe("getModifierJitterIntensity", () => {
  it("is 0 below the +8 threshold", () => {
    expect(getModifierJitterIntensity(7)).toBe(0);
  });

  it("is 0 for negative modifiers", () => {
    expect(getModifierJitterIntensity(-3)).toBe(0);
  });

  it("is already visibly jittering right at +8, not fading in from 0", () => {
    // A floor intensity, not 0 — the acceptance criteria calls for a
    // *visible* jitter the instant a modifier crosses the threshold.
    expect(getModifierJitterIntensity(8)).toBeGreaterThan(0);
  });

  it("ramps monotonically between +8 and the +14 cap", () => {
    const at8 = getModifierJitterIntensity(8);
    const at11 = getModifierJitterIntensity(11);
    const at14 = getModifierJitterIntensity(14);
    expect(at11).toBeGreaterThan(at8);
    expect(at14).toBeGreaterThan(at11);
  });

  it("caps at 1 from +14 upward", () => {
    expect(getModifierJitterIntensity(14)).toBe(1);
    expect(getModifierJitterIntensity(25)).toBe(1);
  });
});
