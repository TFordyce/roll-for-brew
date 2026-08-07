import { describe, expect, it } from "vitest";
import { firstName, firstNameOrFallback } from "@/lib/game/displayName";

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
