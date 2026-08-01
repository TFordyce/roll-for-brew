export type RollCalculationResult =
  | { kind: "nat1" }
  | { kind: "nat20" }
  | { kind: "sum"; roll: number; modifier: number; total: number };

/**
 * Classifies a revealed roll for display purposes (issue #99): a plain roll
 * combines with its modifier into the total resolveLayer actually compares,
 * but nat-1/nat-20 rolls (issue #5) short-circuit that comparison — nat-1
 * brews outright regardless of modifier, and nat-20 is exempted from the
 * layer entirely unless every entry rolled one. Showing "1 + 2 = 3" or
 * "20 + 2 = 22" in either case would misrepresent how the round actually
 * resolved, so those stay a distinct kind rather than a sum.
 */
export function classifyRollCalculation(roll: number, modifier: number): RollCalculationResult {
  if (roll === 1) return { kind: "nat1" };
  if (roll === 20) return { kind: "nat20" };
  return { kind: "sum", roll, modifier, total: roll + modifier };
}

/** The "+2"/"-1" convention every modifier badge in the app already uses (PlayerTile, RoundReveal). */
export function formatModifier(modifier: number): string {
  return modifier >= 0 ? `+${modifier}` : `${modifier}`;
}
