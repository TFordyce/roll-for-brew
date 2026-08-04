import { describe, expect, it } from "vitest";
import { slugifyCardName, spellArtPath } from "./spellArt";

describe("slugifyCardName", () => {
  it("lowercases and hyphenates plain multi-word names", () => {
    expect(slugifyCardName("Six Sugars")).toBe("six-sugars");
    expect(slugifyCardName("Bes-Tea")).toBe("bes-tea");
  });

  it("drops apostrophes rather than turning them into hyphens", () => {
    // Verified against the real public/spell-art/ filenames from PR #125.
    expect(slugifyCardName("Gambler's Infusion")).toBe("gamblers-infusion");
    expect(slugifyCardName("Fortune's Flavour")).toBe("fortunes-flavour");
    expect(slugifyCardName("Saucerer's Apprentice")).toBe("saucerers-apprentice");
    expect(slugifyCardName("Zariel's Fall")).toBe("zariels-fall");
  });

  it("collapses other punctuation (including existing hyphens) to a single separator", () => {
    expect(slugifyCardName("Chai-nge of Heart")).toBe("chai-nge-of-heart");
    expect(slugifyCardName("PG Tipped")).toBe("pg-tipped");
    expect(slugifyCardName("Brew IOU")).toBe("brew-iou");
    expect(slugifyCardName("Milk First?")).toBe("milk-first");
  });
});

describe("spellArtPath", () => {
  it("builds the public/spell-art path from the slug", () => {
    expect(spellArtPath("Cast-Iron Kettle")).toBe("/spell-art/cast-iron-kettle.png");
  });
});
