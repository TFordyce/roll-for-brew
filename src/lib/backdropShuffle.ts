
import { hashString, mulberry32 } from "@/lib/game/deterministicRandom";

export const PROP_KEYS = [
  "kettle",
  "teapot",
  "sugarBowl",
  "milkCarton",
  "coffeeJar",
  "saucerStack",
] as const;

export type PropKey = (typeof PROP_KEYS)[number];

export const SLOT_COUNT = 8;

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getSlotAssignments(playerId: string, date: Date = new Date()): (PropKey | null)[] {
  const seed = hashString(`${playerId}-${dateKey(date)}`);
  const random = mulberry32(seed);
  const slots: (PropKey | null)[] = [
    ...PROP_KEYS,
    ...Array(SLOT_COUNT - PROP_KEYS.length).fill(null),
  ];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = slots[i]!;
    slots[i] = slots[j]!;
    slots[j] = temp;
  }
  return slots;
}
