import type { SpellCollectionCard } from "@/lib/supabase/spellCards";
import { spellArtPath } from "@/lib/spellArt";

export type Tier = SpellCollectionCard["tier"];

export const TIER_ORDER: Tier[] = ["common", "rare", "epic"];

export const TIER_LABEL: Record<Tier, string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
};

export const TIER_BORDER: Record<Tier, string> = {
  common: "border-gilt-dark",
  rare: "border-gilt",
  epic: "border-ember-bright shadow-[0_0_16px_rgb(179_84_63_/_0.55)]",
};

export function isDiscovered(card: { drawCount: number }): boolean {
  return card.drawCount > 0;
}

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
  artClassName: string;
  showDrawBadge: boolean;
};

export type CardTileInput = Pick<SpellCollectionCard, "name" | "tier" | "drawCount">;

export function cardTileView(card: CardTileInput): CardTileView {
  const discovered = isDiscovered(card);
  return {
    discovered,
    artPath: spellArtPath(card.name),
    artClassName: discovered ? "" : "grayscale brightness-[0.3] contrast-125",
    showDrawBadge: discovered && card.drawCount > 1,
  };
}

export type TierFraction = { discovered: number; total: number };

export function tierFractions(cards: SpellCollectionCard[]): Record<Tier, TierFraction> {
  const groups = groupByTier(cards);
  const fractions = {} as Record<Tier, TierFraction>;
  for (const tier of TIER_ORDER) {
    const inTier = groups[tier];
    fractions[tier] = { discovered: inTier.filter(isDiscovered).length, total: inTier.length };
  }
  return fractions;
}
