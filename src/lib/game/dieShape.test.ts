import { describe, expect, it } from "vitest";
import { parseDieShape } from "./dieShape";

describe("parseDieShape", () => {
  it("parses a d4 dice string", () => {
    expect(parseDieShape("1d4")).toBe("d4");
  });

  it("parses a d6 dice string", () => {
    expect(parseDieShape("1d6")).toBe("d6");
  });

  it("parses a d20 dice string", () => {
    expect(parseDieShape("1d20")).toBe("d20");
  });

  it("returns null for an unrecognized die size rather than guessing", () => {
    expect(parseDieShape("1d100")).toBeNull();
  });

  it("returns null for a non-dice string", () => {
    expect(parseDieShape("not-a-die")).toBeNull();
  });
});
