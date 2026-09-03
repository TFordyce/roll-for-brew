import { describe, expect, it } from "vitest";
import {
  AT_CAST_TARGET_CARDS,
  TWO_OTHER_PLAYER_CARDS,
  castTargetMode,
} from "./castTargeting";

type Held = Parameters<typeof castTargetMode>[0];

const card = (over: Partial<Held>): Held => ({
  cardName: "Some Card",
  target: "SELF",
  effectKind: null,
  ...over,
});

describe("castTargetMode", () => {
  it("keeps generic OPPONENT / PLAYER cards on the deferred flow", () => {
    expect(castTargetMode(card({ cardName: "Six Sugars", target: "OPPONENT" }))).toBe("deferred-target");
    expect(castTargetMode(card({ cardName: "Fortune's Flavour", target: "PLAYER" }))).toBe("deferred-target");
  });

  it("routes the rebuild by-name OPPONENT / PLAYER cards to an at-cast single-target select", () => {
    const opponentCards = ["Steaming Mug Bond", "Bes-Tea", "Tea Leaf", "Spillage", "Chai-nge of Heart"];
    for (const name of opponentCards) {
      expect(castTargetMode(card({ cardName: name, target: "OPPONENT" }))).toBe("at-cast-target");
    }
    // Tea for Two is stamped PLAYER, not OPPONENT.
    expect(castTargetMode(card({ cardName: "Tea for Two", target: "PLAYER" }))).toBe("at-cast-target");
  });

  it("routes Stir the Pot to a two-other-players picker even though it is stamped OPPONENT", () => {
    expect(castTargetMode(card({ cardName: "Stir the Pot", target: "OPPONENT" }))).toBe("two-other-players");
  });

  it("never lets a name match override a non-OPPONENT/PLAYER stamp", () => {
    expect(castTargetMode(card({ cardName: "Stir the Pot", target: "SELF" }))).toBe("none");
    expect(castTargetMode(card({ cardName: "Bes-Tea", target: "TABLE" }))).toBe("none");
  });

  it("still renders the CHOSEN_PLAYERS checkbox picker for CHOSEN_PLAYERS cards", () => {
    expect(castTargetMode(card({ cardName: "Group Order", target: "CHOSEN_PLAYERS" }))).toBe("chosen-players");
  });

  it("still renders the declared-number input for the declare-a-number tea-maker card", () => {
    expect(
      castTargetMode(card({ cardName: "Tea Maker's Gambit", target: "TABLE", effectKind: "declared_number_tea_maker" })),
    ).toBe("declared-number");
  });

  it("renders no picker for SELF / TABLE / WILD cards", () => {
    expect(castTargetMode(card({ target: "SELF" }))).toBe("none");
    expect(castTargetMode(card({ target: "TABLE" }))).toBe("none");
    expect(castTargetMode(card({ target: "WILD" }))).toBe("none");
  });

  it("exposes the two name sets it keys off (mirroring cast_spell_card's by-name branches)", () => {
    expect(AT_CAST_TARGET_CARDS.has("Chai-nge of Heart")).toBe(true);
    expect(TWO_OTHER_PLAYER_CARDS.has("Stir the Pot")).toBe(true);
    // Stir the Pot is handled by its own picker, not the single-target select.
    expect(AT_CAST_TARGET_CARDS.has("Stir the Pot")).toBe(false);
  });
});
