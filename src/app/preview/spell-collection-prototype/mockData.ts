/**
 * PROTOTYPE MOCK DATA — throwaway ticket #124 (Spell Collection page:
 * visual design & entry-point prototype). Shapes match the
 * `get_player_spell_collection(p_player_id)` RPC decided in ticket #123:
 * `name`/`tier` always present, `casting_time`/`target`/`effect_text` null
 * until `draw_count > 0`. A 24-card sample stands in for the real 71-card
 * catalog (art from PR #125, not yet merged — six real illustrations
 * shrunk to small webp thumbnails live at /spell-art-prototype/*.webp for
 * this prototype only; the rest reuse those six on rotation).
 */

export type Tier = "common" | "rare" | "epic";

export type CollectionCard = {
  cardId: string;
  name: string;
  tier: Tier;
  castingTime: "A" | "R" | null; // null until discovered
  target: string | null; // null until discovered
  effectText: string | null; // null until discovered
  drawCount: number; // 0 until discovered
};

const ART_ROTATION = [
  "bes-tea",
  "brew-iou",
  "brewmageddon",
  "caffeinated-focus",
  "cast-iron-kettle",
  "gamblers-infusion",
];

export function artFor(cardId: string, index: number): string {
  return `/spell-art-prototype/${ART_ROTATION[index % ART_ROTATION.length]}.webp`;
}

export const TOTAL_CATALOG_SIZE = 71; // real catalog size post-#121 import (PR #125)

// A representative 24-card sample — not the full 71, but enough to judge
// grid density, tier mix, and discovered/undiscovered states side by side.
const RAW: Omit<CollectionCard, "cardId">[] = [
  { name: "Bes-Tea", tier: "common", castingTime: "A", target: "OPPONENT", effectText: "Copy another player's modifier for this round.", drawCount: 3 },
  { name: "Six Sugars", tier: "common", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Lucky Sip", tier: "common", castingTime: "A", target: "SELF", effectText: "Add +3 to your roll this round.", drawCount: 1 },
  { name: "Caffeinated Focus", tier: "common", castingTime: "A", target: "SELF", effectText: "Add +5 to your roll this round.", drawCount: 5 },
  { name: "Double Dunk", tier: "common", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Gambler's Infusion", tier: "common", castingTime: "A", target: "SELF", effectText: "Roll 2d6, take either as your modifier.", drawCount: 2 },
  { name: "Steady Hand", tier: "common", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Sugar Rush", tier: "common", castingTime: "A", target: "SELF", effectText: "Roll with advantage this round.", drawCount: 1 },
  { name: "Milk First?", tier: "common", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Cold Tea", tier: "common", castingTime: "A", target: "OPPONENT", effectText: "Target subtracts 3 from their roll this round; you add 1d4 to yours.", drawCount: 4 },
  { name: "Brewer's Blessing", tier: "common", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Re-Steep", tier: "common", castingTime: "R", target: "SELF", effectText: "Reroll your own d20. You must keep the new result.", drawCount: 1 },
  { name: "Brew IOU", tier: "rare", castingTime: "A", target: "PLAYER", effectText: "Target player owes you a future favour — reroll their next round for them.", drawCount: 2 },
  { name: "Brew-merang", tier: "rare", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Tea for Two", tier: "rare", castingTime: "A", target: "CHOSEN_PLAYERS", effectText: "Choose up to 3 players; each rolls with advantage this round.", drawCount: 1 },
  { name: "Tannin Tantrum", tier: "rare", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Saving Steep", tier: "rare", castingTime: "R", target: "CARD", effectText: "Roll a d20. On 10+, the targeted card has no effect.", drawCount: 3 },
  { name: "Slipped Spoon", tier: "rare", castingTime: "A", target: "OPPONENT", effectText: "Target rolls with disadvantage this round; you add 1d4 to your roll.", drawCount: 4 },
  { name: "Cloud of Cream", tier: "rare", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Steaming Mug Bond", tier: "rare", castingTime: "A", target: "PLAYER", effectText: "You and target player both add +4 to your rolls this round.", drawCount: 1 },
  { name: "Cast-Iron Kettle", tier: "epic", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Brewmageddon", tier: "epic", castingTime: "A", target: "TABLE", effectText: "Every player rerolls their d20 and must keep the new result.", drawCount: 1 },
  { name: "Liquid Courage", tier: "epic", castingTime: null, target: null, effectText: null, drawCount: 0 },
  { name: "Sleeping Camomile", tier: "epic", castingTime: "R", target: "SELF", effectText: "Cancel the next effect cast against you this round, then this card is spent.", drawCount: 2 },
];

export const MOCK_COLLECTION: CollectionCard[] = RAW.map((card, index) => ({
  ...card,
  cardId: `mock-${index}`,
}));

export const MOCK_DISCOVERED_COUNT = MOCK_COLLECTION.filter((c) => c.drawCount > 0).length;

export type MockPlayer = {
  playerId: string;
  displayName: string;
  isSelf?: boolean;
};

// Stands in for RankRow-style roster/leaderboard entries whose names should
// link out to their collection.
export const MOCK_PLAYERS: MockPlayer[] = [
  { playerId: "self", displayName: "You", isSelf: true },
  { playerId: "alex", displayName: "Alex" },
  { playerId: "sam", displayName: "Sam" },
];
