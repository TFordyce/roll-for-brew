export interface LayerEntry {
  playerId: string;
  roll: number;
  modifier: number;
}

export type LayerResult =
  | { outcome: "brewer"; playerId: string }
  | { outcome: "tie"; tiedPlayerIds: string[] };

function toResult(entries: LayerEntry[]): LayerResult {
  const [only, ...rest] = entries;
  if (!only) {
    throw new Error("toResult requires at least one entry");
  }
  if (rest.length === 0) {
    return { outcome: "brewer", playerId: only.playerId };
  }
  return { outcome: "tie", tiedPlayerIds: entries.map((e) => e.playerId) };
}

function lowestBy(entries: LayerEntry[], value: (e: LayerEntry) => number): LayerEntry[] {
  const lowest = Math.min(...entries.map(value));
  return entries.filter((e) => value(e) === lowest);
}

/**
 * Resolves one layer of a round: the brewer, or the tied subset that must
 * reroll in the next layer. Nat-1/nat-20 precedence per the office game's rules.
 */
export function resolveLayer(entries: LayerEntry[]): LayerResult {
  if (entries.length === 0) {
    throw new Error("resolveLayer requires at least one entry");
  }

  const nat1s = entries.filter((e) => e.roll === 1);
  if (nat1s.length > 0) {
    return toResult(lowestBy(nat1s, (e) => e.modifier));
  }

  const allNat20 = entries.every((e) => e.roll === 20);
  if (allNat20) {
    return toResult(lowestBy(entries, (e) => e.modifier));
  }

  const candidates = entries.filter((e) => e.roll !== 20);
  return toResult(lowestBy(candidates, (e) => e.roll + e.modifier));
}
