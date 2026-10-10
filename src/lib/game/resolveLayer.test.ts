import { describe, expect, it } from "vitest";
import { resolveLayer, type LayerEntry } from "./resolveLayer";

const entry = (playerId: string, roll: number, modifier = 0): LayerEntry => ({
  playerId,
  roll,
  modifier,
});

describe("resolveLayer", () => {
  it("resolves a plain lowest roll+modifier total with no nats and no tie", () => {
    const result = resolveLayer([
      entry("a", 10, 0),
      entry("b", 8, 1),
      entry("c", 15, 0),
    ]);

    expect(result).toEqual({ outcome: "brewer", playerId: "b" });
  });

  it("brews a single nat-1 outright, ignoring modifier", () => {
    const result = resolveLayer([
      entry("a", 1, 99),
      entry("b", 2, -50),
      entry("c", 15, 0),
    ]);

    expect(result).toEqual({ outcome: "brewer", playerId: "a" });
  });

  it("tie-breaks multiple nat-1s on modifier alone", () => {
    const result = resolveLayer([
      entry("a", 1, 5),
      entry("b", 1, 2),
      entry("c", 1, 8),
      entry("d", 10, -100),
    ]);

    expect(result).toEqual({ outcome: "brewer", playerId: "b" });
  });

  it("recurses into a further layer when nat-1 modifiers also tie", () => {
    const result = resolveLayer([
      entry("a", 1, 3),
      entry("b", 1, 3),
      entry("c", 1, 8),
    ]);

    expect(result).toEqual({ outcome: "tie", tiedPlayerIds: ["a", "b"] });
  });

  it("excludes nat-20s in the normal (not-all-nat-20) case", () => {
    const result = resolveLayer([
      entry("a", 20, -100),
      entry("b", 5, 2),
      entry("c", 6, 3),
    ]);

    expect(result).toEqual({ outcome: "brewer", playerId: "b" });
  });

  it("falls back to modifier-only comparison when every entry is nat-20", () => {
    const result = resolveLayer([
      entry("a", 20, 4),
      entry("b", 20, 1),
      entry("c", 20, 7),
    ]);

    expect(result).toEqual({ outcome: "brewer", playerId: "b" });
  });

  it("ties an all-nat-20 round when modifiers also tie", () => {
    const result = resolveLayer([
      entry("a", 20, 4),
      entry("b", 20, 4),
      entry("c", 20, 7),
    ]);

    expect(result).toEqual({ outcome: "tie", tiedPlayerIds: ["a", "b"] });
  });

  it("ties a non-nat roll+modifier total", () => {
    const result = resolveLayer([
      entry("a", 8, 2),
      entry("b", 7, 3),
      entry("c", 15, 0),
    ]);

    expect(result).toEqual({ outcome: "tie", tiedPlayerIds: ["a", "b"] });
  });

  it("resolves a non-nat tie by recursing through 2+ reroll layers", () => {
    const layer0 = resolveLayer([
      entry("a", 15, 0),
      entry("b", 7, 3),
      entry("c", 4, 6),
    ]);
    expect(layer0).toEqual({ outcome: "tie", tiedPlayerIds: ["b", "c"] });

    const layer1 = resolveLayer([
      entry("b", 5, 3),
      entry("c", 2, 6),
    ]);
    expect(layer1).toEqual({ outcome: "tie", tiedPlayerIds: ["b", "c"] });

    const layer2 = resolveLayer([
      entry("b", 9, 3),
      entry("c", 1, 6),
    ]);
    expect(layer2).toEqual({ outcome: "brewer", playerId: "c" });
  });

  it("resolves the last remaining player when a single entry is passed", () => {
    const result = resolveLayer([entry("a", 12, 0)]);

    expect(result).toEqual({ outcome: "brewer", playerId: "a" });
  });

  it("throws on an empty entries array", () => {
    expect(() => resolveLayer([])).toThrow();
  });
});
