/**
 * Which target control `CastForm` renders for a held Action card, at cast time.
 *
 * Most OPPONENT / PLAYER cards arm with no target and get their target filled
 * in once declare-in closes and the roster is final (the `target_pending`
 * flow — `setSpellCastTargetAction`). The effect-application rebuild's by-name
 * cards (issue #302 and its slices) instead need an *explicit* target at cast
 * time: their `cast_spell_card` branch raises `RFB46` when none is given, with
 * no deferred path. Issue #360 wires the pre-roll pickers for those cards.
 *
 * These two sets mirror the by-name branches in `cast_spell_card`
 * (supabase/migrations/0096_chosen_pair_roll_transform.sql for the #318 cards,
 * plus #342/#343's Bes-Tea / Tea Leaf / Spillage / Chai-nge of Heart). Keep
 * them in sync when another by-name OPPONENT/PLAYER special-case is added.
 */

/** By-name cards that need a single explicit non-caster target chosen at cast. */
export const AT_CAST_TARGET_CARDS: ReadonlySet<string> = new Set([
  // #318 — chosen-pair roll transform (caster + target both in the pair)
  "Steaming Mug Bond",
  "Tea for Two",
  // #343 — round-scoped modifier snapshot cards (steal / copy a modifier)
  "Bes-Tea",
  "Tea Leaf",
  "Spillage",
  // #342 — durable persistent-modifier transfer
  "Chai-nge of Heart",
]);

/**
 * By-name cards that need exactly two *other* players (never the caster)
 * chosen at cast — their own bespoke picker, submitted as `chosenPlayerIds`.
 */
export const TWO_OTHER_PLAYER_CARDS: ReadonlySet<string> = new Set([
  // #318 — Stir the Pot swaps two other players' rolls
  "Stir the Pot",
]);

export type CastTargetMode =
  /** No picker — SELF / TABLE / WILD, or an OPPONENT/PLAYER card handled elsewhere. */
  | "none"
  /** OPPONENT / PLAYER card armed now, target chosen after declare-in closes. */
  | "deferred-target"
  /** OPPONENT / PLAYER by-name card: single non-caster target select, now. */
  | "at-cast-target"
  /** Exactly two other players, chosen now (Stir the Pot). */
  | "two-other-players"
  /** The blanket CHOSEN_PLAYERS checkbox picker. */
  | "chosen-players"
  /** The declare-a-number (1–20) tea-maker input. */
  | "declared-number";

type HeldForTargeting = {
  cardName: string;
  target: string;
  effectKind: string | null;
};

export function castTargetMode(held: HeldForTargeting): CastTargetMode {
  if (TWO_OTHER_PLAYER_CARDS.has(held.cardName)) return "two-other-players";
  if (AT_CAST_TARGET_CARDS.has(held.cardName)) return "at-cast-target";
  if (held.target === "OPPONENT" || held.target === "PLAYER") return "deferred-target";
  if (held.target === "CHOSEN_PLAYERS") return "chosen-players";
  if (held.effectKind === "declared_number_tea_maker") return "declared-number";
  return "none";
}
