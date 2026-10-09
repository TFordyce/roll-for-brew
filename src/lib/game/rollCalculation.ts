export type RollCalculationResult =
  | { kind: "nat1" }
  | { kind: "nat20" }
  | { kind: "sum"; roll: number; modifier: number; total: number };

export function classifyRollCalculation(roll: number, modifier: number): RollCalculationResult {
  if (roll === 1) return { kind: "nat1" };
  if (roll === 20) return { kind: "nat20" };
  return { kind: "sum", roll, modifier, total: roll + modifier };
}

export function formatModifier(modifier: number): string {
  return modifier >= 0 ? `+${modifier}` : `${modifier}`;
}

const JITTER_THRESHOLD = 8;
const JITTER_CAP = 14;
const JITTER_FLOOR = 0.25;

export function getModifierJitterIntensity(modifier: number): number {
  if (modifier < JITTER_THRESHOLD) return 0;
  if (modifier >= JITTER_CAP) return 1;
  const ramp = (modifier - JITTER_THRESHOLD) / (JITTER_CAP - JITTER_THRESHOLD);
  return JITTER_FLOOR + (1 - JITTER_FLOOR) * ramp;
}
