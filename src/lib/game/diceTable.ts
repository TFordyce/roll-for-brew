// Where the round's dice sit, as pure geometry.
//
// The dice table is a reserved strip along the bottom of the viewport, on the
// pixel-art scene's plank. This module decides everything about that strip —
// how big the dice are, how many rows it needs, and which slot each
// participant's die rests in — and nothing about how it is drawn. The surface
// is scene-anchored: the strip is sized to stay inside the art for any roster a
// real room has.
//
// Slots are assigned from a canonical participant order, so every client lays
// the same round out identically no matter what order the roster arrived in.

import { DIE_SIZE_PX } from "./d20Geometry";
import { type ViewportSize, sceneVisibleHeight } from "./sceneGeometry";

export const DIE_MIN_PX = 28;
export const DIE_GAP_PX = 12;
export const TABLE_SIDE_PAD_PX = 16;
export const TABLE_BOTTOM_PAD_PX = 16;
export const MAX_TABLE_ROWS = 3;

// Tried in order until the table fits the strip. A narrower die and a tighter
// gap buy another column before the table is allowed to grow a row.
const DIE_SIZE_CANDIDATES = [DIE_SIZE_PX, 32, DIE_MIN_PX] as const;
const GAP_CANDIDATES = [DIE_GAP_PX, 8, 4] as const;

export type DiceTableSlot = {
  readonly playerId: string;
  /** Centre of the die, in viewport pixels. */
  readonly x: number;
  /** Centre of the die, in viewport pixels. */
  readonly y: number;
  readonly row: number;
  readonly column: number;
};

export type DiceTableLayout = {
  readonly dieSizePx: number;
  readonly gapPx: number;
  /** How much of the viewport bottom the table reserves. */
  readonly tableHeightPx: number;
  readonly rows: number;
  readonly perRow: number;
  readonly slots: readonly DiceTableSlot[];
};

export function canonicalParticipantOrder(playerIds: readonly string[]): string[] {
  return [...playerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function capacityOf(usableWidth: number, dieSize: number, gap: number): number {
  return Math.max(1, Math.floor((usableWidth + gap) / (dieSize + gap)));
}

function maxRowsFor(viewport: ViewportSize, dieSize: number, gap: number): number {
  const visible = sceneVisibleHeight(viewport);
  const fitting = Math.floor((visible - TABLE_BOTTOM_PAD_PX * 2 + gap) / (dieSize + gap));
  return Math.max(1, Math.min(MAX_TABLE_ROWS, fitting));
}

export function computeTableLayout({
  participantIds,
  viewport,
}: {
  participantIds: readonly string[];
  viewport: ViewportSize;
}): DiceTableLayout {
  const ids = canonicalParticipantOrder(participantIds);
  const count = ids.length;
  const width = Math.max(0, viewport.width);
  const height = Math.max(0, viewport.height);
  const usableWidth = Math.max(0, width - TABLE_SIDE_PAD_PX * 2);

  let dieSize: number = DIE_MIN_PX;
  let gap: number = GAP_CANDIDATES[GAP_CANDIDATES.length - 1]!;
  let perRow = capacityOf(usableWidth, dieSize, gap);
  let rows = count === 0 ? 0 : Math.ceil(count / perRow);

  if (count > 0) {
    let chosen = false;
    for (const candidateSize of DIE_SIZE_CANDIDATES) {
      for (const candidateGap of GAP_CANDIDATES) {
        const candidatePerRow = capacityOf(usableWidth, candidateSize, candidateGap);
        const candidateRows = Math.ceil(count / candidatePerRow);
        if (candidateRows <= maxRowsFor(viewport, candidateSize, candidateGap)) {
          dieSize = candidateSize;
          gap = candidateGap;
          perRow = candidatePerRow;
          rows = candidateRows;
          chosen = true;
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen) {
      // Only reachable with rosters far larger than any real room (roughly
      // 40+ at phone width). Keep the smallest dice and let the rows grow
      // upward past the art rather than dropping a player or shrinking a die
      // below its legible floor. Slots stay clamped on screen.
      dieSize = DIE_MIN_PX;
      gap = GAP_CANDIDATES[GAP_CANDIDATES.length - 1]!;
      perRow = capacityOf(usableWidth, dieSize, gap);
      rows = Math.ceil(count / perRow);
    }
  }

  const tableHeightPx =
    count === 0
      ? 0
      : Math.min(height, TABLE_BOTTOM_PAD_PX * 2 + rows * dieSize + (rows - 1) * gap);

  const half = dieSize / 2;
  const slots: DiceTableSlot[] = ids.map((playerId, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    const rowStart = row * perRow;
    const rowCount = Math.min(perRow, count - rowStart);
    const rowWidth = rowCount * dieSize + (rowCount - 1) * gap;
    const startX = (width - rowWidth) / 2 + half;
    const rawX = startX + column * (dieSize + gap);
    const rawY = height - TABLE_BOTTOM_PAD_PX - half - row * (dieSize + gap);
    return {
      playerId,
      x: clamp(rawX, half, Math.max(half, width - half)),
      y: clamp(rawY, half, Math.max(half, height - half)),
      row,
      column,
    };
  });

  return { dieSizePx: dieSize, gapPx: gap, tableHeightPx, rows, perRow, slots };
}
