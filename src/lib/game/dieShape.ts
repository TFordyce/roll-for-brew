export type DieShape = "d4" | "d6" | "d20";

export function parseDieShape(dice: string): DieShape | null {
  const match = /d(\d+)$/.exec(dice);
  if (!match) return null;
  const sides = `d${match[1]}`;
  return sides === "d4" || sides === "d6" || sides === "d20" ? sides : null;
}

export function parseDiceRange(dice: string): { min: number; max: number } | null {
  const match = /^(\d+)d(\d+)$/.exec(dice);
  if (!match) return null;
  const count = Number(match[1]);
  const sides = Number(match[2]);
  return { min: count, max: count * sides };
}
