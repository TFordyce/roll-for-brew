import { describe, expect, it } from "vitest";
import type { SpellCollectionCard } from "@/lib/supabase/spellCards";
import { cardTileView, groupByTier, isDiscovered, tierFractions } from "./spellCollection";

function card(overrides: Partial<SpellCollectionCard> & { name: string; tier: SpellCollectionCard["tier"] }): SpellCollectionCard {
  return {
    cardId: overrides.name,
    castingTime: null,
    target: null,
    effectText: null,
    drawCount: 0,
    ...overrides,
  };
}

describe("isDiscovered", () => {
  it("is true once a card has been drawn at least once", () => {
    expect(isDiscovered(card({ name: "Lucky Sip", tier: "common", drawCount: 1 }))).toBe(true);
  });

  it("is false for a card with a zero draw count", () => {
    expect(isDiscovered(card({ name: "Six Sugars", tier: "common", drawCount: 0 }))).toBe(false);
  });
});

describe("groupByTier", () => {
  it("buckets cards by tier, preserving RPC row order within each bucket", () => {
    const cards = [
      card({ name: "Bes-Tea", tier: "common" }),
      card({ name: "Brew IOU", tier: "rare" }),
      card({ name: "Brewmageddon", tier: "epic" }),
      card({ name: "Six Sugars", tier: "common" }),
    ];

    const groups = groupByTier(cards);

    expect(groups.common.map((c) => c.name)).toEqual(["Bes-Tea", "Six Sugars"]);
    expect(groups.rare.map((c) => c.name)).toEqual(["Brew IOU"]);
    expect(groups.epic.map((c) => c.name)).toEqual(["Brewmageddon"]);
  });

  it("returns an empty array (not undefined) for a tier with no rows", () => {
    const groups = groupByTier([]);
    expect(groups.common).toEqual([]);
    expect(groups.rare).toEqual([]);
    expect(groups.epic).toEqual([]);
  });
});

describe("cardTileView", () => {
  it("shows plain-color art with no dimming class once discovered", () => {
    const view = cardTileView(card({ name: "Lucky Sip", tier: "common", drawCount: 1 }));
    expect(view.discovered).toBe(true);
    expect(view.artClassName).toBe("");
    expect(view.artPath).toBe("/spell-art/lucky-sip.png");
  });

  it("dims (grayscales) the art for an undiscovered card", () => {
    const view = cardTileView(card({ name: "Six Sugars", tier: "common", drawCount: 0 }));
    expect(view.discovered).toBe(false);
    expect(view.artClassName).toContain("grayscale");
  });

  it("hides the draw-count badge for an undiscovered card", () => {
    expect(cardTileView(card({ name: "Six Sugars", tier: "common", drawCount: 0 })).showDrawBadge).toBe(false);
  });

  it("hides the draw-count badge on the first draw (×1 is redundant with color art)", () => {
    expect(cardTileView(card({ name: "Lucky Sip", tier: "common", drawCount: 1 })).showDrawBadge).toBe(false);
  });

  it("shows the draw-count badge from the second draw onward", () => {
    expect(cardTileView(card({ name: "Lucky Sip", tier: "common", drawCount: 2 })).showDrawBadge).toBe(true);
  });
});

describe("tierFractions", () => {
  it("computes each tier's discovered/total sub-fraction independently", () => {
    const cards = [
      card({ name: "Bes-Tea", tier: "common", drawCount: 3 }),
      card({ name: "Six Sugars", tier: "common", drawCount: 0 }),
      card({ name: "Brew IOU", tier: "rare", drawCount: 1 }),
      card({ name: "Brewmageddon", tier: "epic", drawCount: 0 }),
    ];

    expect(tierFractions(cards)).toEqual({
      common: { discovered: 1, total: 2 },
      rare: { discovered: 1, total: 1 },
      epic: { discovered: 0, total: 1 },
    });
  });

  it("is all-zero-discovered for a zero-draws player (empty-collection-in-spirit case)", () => {
    const cards = [
      card({ name: "Bes-Tea", tier: "common", drawCount: 0 }),
      card({ name: "Brew IOU", tier: "rare", drawCount: 0 }),
      card({ name: "Brewmageddon", tier: "epic", drawCount: 0 }),
    ];

    const fractions = tierFractions(cards);
    expect(fractions.common.discovered).toBe(0);
    expect(fractions.rare.discovered).toBe(0);
    expect(fractions.epic.discovered).toBe(0);
  });

  it("handles a truly empty catalog without throwing", () => {
    expect(tierFractions([])).toEqual({
      common: { discovered: 0, total: 0 },
      rare: { discovered: 0, total: 0 },
      epic: { discovered: 0, total: 0 },
    });
  });
});
