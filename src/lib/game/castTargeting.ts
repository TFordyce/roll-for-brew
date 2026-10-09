import type { HeldSpellCard } from "@/lib/supabase/spellCards";


export const AT_CAST_TARGET_CARDS: ReadonlySet<string> = new Set([
  "Steaming Mug Bond",
  "Tea for Two",
  "Bes-Tea",
  "Tea Leaf",
  "Spillage",
  "Chai-nge of Heart",
  "Tea Heist",
]);

const CARD_HOLDER_TARGET_CARDS: ReadonlySet<string> = new Set(["Tea Heist"]);

export function atCastTargetOptions<P extends { playerId: string }>(
  cardName: string,
  otherParticipants: P[],
  cardHolderIds: readonly string[],
): P[] {
  if (!CARD_HOLDER_TARGET_CARDS.has(cardName)) return otherParticipants;
  return otherParticipants.filter((p) => cardHolderIds.includes(p.playerId));
}

export const TWO_OTHER_PLAYER_CARDS: ReadonlySet<string> = new Set([
  "Stir the Pot",
]);

export type CastTargetMode =
  | "none"
  | "deferred-target"
  | "at-cast-target"
  | "two-other-players"
  | "chosen-players"
  | "declared-number";

type HeldForTargeting = Pick<HeldSpellCard, "cardName" | "target" | "effectKind">;

export function castTargetMode(held: HeldForTargeting): CastTargetMode {
  const singleOtherStamp = held.target === "OPPONENT" || held.target === "PLAYER";
  if (singleOtherStamp && TWO_OTHER_PLAYER_CARDS.has(held.cardName)) return "two-other-players";
  if (singleOtherStamp && AT_CAST_TARGET_CARDS.has(held.cardName)) return "at-cast-target";
  if (singleOtherStamp) return "deferred-target";
  if (held.target === "CHOSEN_PLAYERS") return "chosen-players";
  if (held.effectKind === "declared_number_tea_maker") return "declared-number";
  return "none";
}

export function compelledCastTargetMode(held: HeldForTargeting): {
  mode: CastTargetMode;
  includeSelf: boolean;
} {
  const mode = castTargetMode(held);
  if (mode === "deferred-target" || held.target === "WILD") {
    return { mode: "at-cast-target", includeSelf: held.target !== "OPPONENT" };
  }
  return { mode, includeSelf: false };
}
