import { describe, expect, it } from "vitest";
import { shouldClearRevealHold } from "./revealHold";

describe("shouldClearRevealHold (issue #595)", () => {
  it("keeps the hold while the held round itself is still shown as active", () => {
    expect(shouldClearRevealHold("round-1", "round-1")).toBe(false);
  });

  it("clears the hold once a different round goes active", () => {
    expect(shouldClearRevealHold("round-2", "round-1")).toBe(true);
  });

  it("keeps the hold once no round is active", () => {
    expect(shouldClearRevealHold(null, "round-1")).toBe(false);
  });

  it("never clears when there is no hold", () => {
    expect(shouldClearRevealHold("round-1", null)).toBe(false);
    expect(shouldClearRevealHold(null, null)).toBe(false);
    expect(shouldClearRevealHold(undefined, "round-1")).toBe(false);
    expect(shouldClearRevealHold("round-1", undefined)).toBe(false);
  });
});
