/**
 * Deterministic per-player, per-day shuffle of the tavern-counter backdrop
 * props (issue #82) — same layout all day for a given player, reshuffles at
 * the next UTC date, independent across players. No cryptographic strength
 * needed, just a stable seed -> stable Fisher-Yates order.
 */

export const PROP_KEYS = [
  "kettle",
  "teapot",
  "mugRack",
  "sugarBowl",
  "milkCarton",
  "coffeeJar",
  "teaTowel",
  "saucerStack",
] as const;

export type PropKey = (typeof PROP_KEYS)[number];

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns the 8 prop keys in slot order (index = slot position) for a given
 * player on a given day.
 */
export function getSlotAssignments(playerId: string, date: Date = new Date()): PropKey[] {
  const seed = hashString(`${playerId}-${dateKey(date)}`);
  const random = mulberry32(seed);
  const slots: PropKey[] = [...PROP_KEYS];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = slots[i]!;
    slots[i] = slots[j]!;
    slots[j] = temp;
  }
  return slots;
}
