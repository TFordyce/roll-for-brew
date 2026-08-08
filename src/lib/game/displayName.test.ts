import { describe, expect, it } from "vitest";
import { firstName, firstNameOrFallback, joinNames } from "@/lib/game/displayName";

describe("firstName", () => {
  it("drops the surname from a two-part name", () => {
    expect(firstName("Ada Lovelace")).toBe("Ada");
  });

  it("leaves a single-word name unchanged", () => {
    expect(firstName("Ada")).toBe("Ada");
  });

  it("takes only the first word of a name with more than two parts", () => {
    expect(firstName("Ada Byron Lovelace")).toBe("Ada");
  });

  it("collapses stray whitespace before extracting the first word", () => {
    expect(firstName("  Ada   Lovelace  ")).toBe("Ada");
  });

  it("falls back to the original string for an empty/whitespace-only name", () => {
    expect(firstName("")).toBe("");
    expect(firstName("   ")).toBe("   ");
  });
});

describe("firstNameOrFallback", () => {
  it("extracts the first name from an actual display name", () => {
    expect(firstNameOrFallback("Ada Lovelace", "ada@example.com")).toBe("Ada");
  });

  it("skips extraction for a null display name, using the fallback as-is", () => {
    expect(firstNameOrFallback(null, "ada@example.com")).toBe("ada@example.com");
  });
});

describe("joinNames", () => {
  it("returns the fallback for an empty list", () => {
    expect(joinNames([], "nobody")).toBe("nobody");
  });

  it("returns a single name unchanged", () => {
    expect(joinNames(["Ada"], "nobody")).toBe("Ada");
  });

  it("joins two names with 'and', no comma", () => {
    expect(joinNames(["Ada", "Grace"], "nobody")).toBe("Ada and Grace");
  });

  it("comma-separates all but the last name, joined with 'and'", () => {
    expect(joinNames(["Ada", "Grace", "Katherine"], "nobody")).toBe("Ada, Grace and Katherine");
  });
});
