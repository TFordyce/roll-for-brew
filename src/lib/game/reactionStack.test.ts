import { describe, expect, it } from "vitest";
import { isReactionWindowClosed, orderStackForResolution } from "./reactionStack";

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
    // p3 passed earlier but isn't in the current eligible set (e.g. they
    // never held a Reaction card, or the set was recomputed) — extra passes
    // beyond the eligible set don't affect whether it's closed.
    expect(isReactionWindowClosed(["p1"], ["p1", "p3"])).toBe(true);
  });

  it("stays open for a newly-eligible player even if everyone else already passed", () => {
    // Models chaining: a new cast reopens the poll and brings a fresh
    // eligible player into the set who hasn't passed this poll round yet.
    expect(isReactionWindowClosed(["p1", "p2", "p4"], ["p1", "p2"])).toBe(false);
  });
});

describe("orderStackForResolution", () => {
  it("orders casts LIFO — last cast (highest seq) first", () => {
    const entries = [
      { castId: "a", seq: 1, parentCastId: null },
      { castId: "b", seq: 3, parentCastId: "a" },
      { castId: "c", seq: 2, parentCastId: "a" },
    ];

    expect(orderStackForResolution(entries).map((e) => e.castId)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const entries = [
      { castId: "a", seq: 1, parentCastId: null },
      { castId: "b", seq: 2, parentCastId: null },
    ];

    orderStackForResolution(entries);

    expect(entries.map((e) => e.castId)).toEqual(["a", "b"]);
  });
});
