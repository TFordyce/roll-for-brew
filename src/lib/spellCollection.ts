import type { SpellCollectionCard } from "@/lib/supabase/spellCards";
import { spellArtPath } from "@/lib/spellArt";

/**
 * Pure view-model helpers for the Spell Collection page (issue #134, part
 * of spec #130) — tier grouping/labels and the discovered/total
 * sub-fractions each tier tab shows. Pulled out of the grid/card components
 * (mirroring ParallaxBackdrop's computeSceneScale) so this logic is
 * unit-testable without rendering, and shared between `SpellCollectionGrid`
 * and `SpellCollectionCard` without a circular import between them.
 */
export type Tier = SpellCollectionCard["tier"];

export const TIER_ORDER: Tier[] = ["common", "rare", "epic"];

export const TIER_LABEL: Record<Tier, string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
};

/** A card counts as discovered once it's been drawn at least once (#133: no separate boolean column). */
export function isDiscovered(card: SpellCollectionCard): boolean {
  return card.drawCount > 0;
}

/** Groups the full catalog by tier, preserving the RPC's row order within each group. */
export function groupByTier(cards: SpellCollectionCard[]): Record<Tier, SpellCollectionCard[]> {
  const groups: Record<Tier, SpellCollectionCard[]> = { common: [], rare: [], epic: [] };
  for (const card of cards) {
    groups[card.tier].push(card);
  }
  return groups;
}

export type CardTileView = {
  discovered: boolean;
  artPath: string;
  /** Applied to the `<img>` — grayscale/dimmed while undiscovered, plain color once drawn. */
  artClassName: string;
  /** ×N draw-count badge: discovered cards only, and only once N > 1 ("×1" is redundant with color art). */
  showDrawBadge: boolean;
};

/**
 * The discovered/undiscovered rendering decisions a grid tile makes (art
 * dimming, badge visibility) — extracted so those decisions are
 * unit-testable independent of JSX (issue #134 acceptance criteria).
 */
export function cardTileView(card: SpellCollectionCard): CardTileView {
  const discovered = isDiscovered(card);
  return {
    discovered,
    artPath: spellArtPath(card.name),
    artClassName: discovered ? "" : "grayscale brightness-[0.3] contrast-125",
    showDrawBadge: discovered && card.drawCount > 1,
  };
}

export type TierFraction = { discovered: number; total: number };

/** The `discovered/total` sub-fraction each tier tab shows (#134 acceptance criteria). */
export function tierFractions(cards: SpellCollectionCard[]): Record<Tier, TierFraction> {
  const groups = groupByTier(cards);
  const fractions = {} as Record<Tier, TierFraction>;
  for (const tier of TIER_ORDER) {
    const inTier = groups[tier];
    fractions[tier] = { discovered: inTier.filter(isDiscovered).length, total: inTier.length };
  }
  return fractions;
}
