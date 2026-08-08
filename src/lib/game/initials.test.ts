import { describe, expect, it } from "vitest";
import { initialsFrom } from "./initials";

describe("initialsFrom", () => {
  it("takes the first letter of the first two words of a display name", () => {
    expect(initialsFrom("Tom Fordyce", "tom@example.com")).toBe("T.F.");
  });

  it("uses a single letter for a single-word display name", () => {
    expect(initialsFrom("Sam", "sam@example.com")).toBe("S.");
  });

  it("ignores extra words beyond the first two", () => {
    expect(initialsFrom("Sam Jo Alexander Smith", "sam@example.com")).toBe("S.J.");
  });

  it("falls back to the email's local part when there is no display name", () => {
    expect(initialsFrom(null, "tom@example.com")).toBe("T.");
  });

  it("falls back to the email's local part for a blank display name", () => {
    expect(initialsFrom("   ", "tom@example.com")).toBe("T.");
  });
});
