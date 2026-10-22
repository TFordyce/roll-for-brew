import { describe, expect, it } from "vitest";
import { isReactionWindowClosed } from "./reactionStack";

describe("isReactionWindowClosed", () => {
  it("is open while at least one eligible player hasn't passed", () => {
    expect(isReactionWindowClosed(["p1", "p2"], ["p1"])).toBe(false);
  });

  it("closes once every eligible player has passed", () => {
    expect(isReactionWindowClosed(["p1", "p2"], ["p1", "p2"])).toBe(true);
  });

  it("closes immediately when nobody is eligible", () => {
    expect(isReactionWindowClosed([], [])).toBe(true);
  });

  it("ignores a pass from a player who is no longer eligible", () => {
    expect(isReactionWindowClosed(["p1"], ["p1", "p3"])).toBe(true);
  });

  it("stays open for a newly-eligible player even if everyone else already passed", () => {
    expect(isReactionWindowClosed(["p1", "p2", "p4"], ["p1", "p2"])).toBe(false);
  });
});

