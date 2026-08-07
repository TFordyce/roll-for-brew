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

/** Where the "danger" jitter cue on a high modifier starts (issue #196). */
const JITTER_THRESHOLD = 8;
/** Modifier value at which jitter intensity hits its readable maximum (issue #196). */
const JITTER_CAP = 14;
/**
 * Intensity right at the threshold — a floor rather than 0, so the jitter is
 * visible the instant a modifier crosses +8 instead of fading in from
 * nothing (issue #196's acceptance criteria calls for a visible cue at +8).
 */
const JITTER_FLOOR = 0.25;

/**
 * Jitter intensity (0-1) for the modifier term in RollCalculation's rich
 * mode (issue #196) — a "danger" cue when a player's modifier is running
 * away with the round. The threshold is absolute (+8), not relative to
 * other players: a relative "double the next-highest" rule false-positives
 * early game, since the first player to pull ahead is trivially "infinitely"
 * ahead of everyone still at +0.
 *
 * Ramps linearly from a floor at +8 (just starting to jitter, but already
 * visible) to full intensity at +14, then holds at 1 so very high modifiers
 * don't become unreadable visual noise. These numbers came from
 * conversation, not a tuning pass — see the #196 write-up for how they were
 * eyeballed.
 */
export function getModifierJitterIntensity(modifier: number): number {
  if (modifier < JITTER_THRESHOLD) return 0;
  if (modifier >= JITTER_CAP) return 1;
  const ramp = (modifier - JITTER_THRESHOLD) / (JITTER_CAP - JITTER_THRESHOLD);
  return JITTER_FLOOR + (1 - JITTER_FLOOR) * ramp;
}
