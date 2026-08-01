import { describe, expect, it } from "vitest";
import { classifyRollCalculation } from "./rollCalculation";

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
