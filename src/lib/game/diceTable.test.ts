import { describe, expect, it } from "vitest";
import {
  DIE_GAP_PX,
  DIE_MIN_PX,
  MAX_TABLE_ROWS,
  TABLE_BOTTOM_PAD_PX,
  canonicalParticipantOrder,
  computeTableLayout,
  tableObstacles,
} from "./diceTable";
import { DIE_SIZE_PX } from "./d20Geometry";
import { sceneVisibleHeight } from "./sceneGeometry";

const VIEWPORTS = [
  { name: "small phone", width: 320, height: 568 },
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1376, height: 900 },
  { name: "wide desktop", width: 1920, height: 1080 },
];

const PLAYER_IDS = (count: number) =>
  Array.from({ length: count }, (_, i) => `player-${String(i).padStart(2, "0")}`);

const layoutFor = (count: number, width: number, height: number) =>
  computeTableLayout({
    participantIds: PLAYER_IDS(count),
    viewport: { width, height },
  });

describe("canonicalParticipantOrder", () => {
  it("sorts by player id so the order never depends on arrival order", () => {
    expect(canonicalParticipantOrder(["c", "a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the caller's array", () => {
    const input = ["c", "a", "b"];
    canonicalParticipantOrder(input);
    expect(input).toEqual(["c", "a", "b"]);
  });
});

describe("computeTableLayout", () => {
  it("gives the same slots however the roster arrives", () => {
    const ids = PLAYER_IDS(5);
    const shuffled = [ids[3]!, ids[0]!, ids[4]!, ids[2]!, ids[1]!];
    const viewport = { width: 1376, height: 900 };

    const a = computeTableLayout({ participantIds: ids, viewport });
    const b = computeTableLayout({ participantIds: shuffled, viewport });

    expect(b.slots).toEqual(a.slots);
  });

  it("gives a different roster a different slot assignment", () => {
    const viewport = { width: 1376, height: 900 };
    const a = computeTableLayout({ participantIds: PLAYER_IDS(5), viewport });
    const b = computeTableLayout({ participantIds: PLAYER_IDS(4), viewport });

    expect(b.slots).not.toEqual(a.slots);
  });

  it("places every player exactly once, on a unique slot", () => {
    const ids = PLAYER_IDS(8);
    const { slots } = computeTableLayout({
      participantIds: ids,
      viewport: { width: 1376, height: 900 },
    });

    expect(slots.map((s) => s.playerId)).toEqual([...ids].sort());
    const centres = new Set(slots.map((s) => `${s.x},${s.y}`));
    expect(centres.size).toBe(slots.length);
  });

  it("returns an empty table for an empty roster", () => {
    const layout = layoutFor(0, 1376, 900);

    expect(layout.slots).toEqual([]);
    expect(layout.rows).toBe(0);
    expect(layout.tableHeightPx).toBe(0);
  });

  it.each(VIEWPORTS)("keeps every die fully on screen at $name", ({ width, height }) => {
    for (const count of [1, 2, 4, 8, 12]) {
      const layout = layoutFor(count, width, height);
      const half = layout.dieSizePx / 2;

      for (const slot of layout.slots) {
        expect(slot.x - half).toBeGreaterThanOrEqual(0);
        expect(slot.x + half).toBeLessThanOrEqual(width);
        expect(slot.y - half).toBeGreaterThanOrEqual(0);
        expect(slot.y + half).toBeLessThanOrEqual(height);
      }
    }
  });

  it.each(VIEWPORTS)("keeps the table inside the painted scene at $name", ({ width, height }) => {
    for (const count of [1, 2, 4, 8, 12]) {
      const layout = layoutFor(count, width, height);

      expect(layout.tableHeightPx).toBeLessThanOrEqual(sceneVisibleHeight({ width, height }));
    }
  });

  it.each(VIEWPORTS)("anchors the whole table to the bottom at $name", ({ width, height }) => {
    for (const count of [1, 2, 4, 8, 12, 20]) {
      const layout = layoutFor(count, width, height);
      const tableTop = height - layout.tableHeightPx;

      for (const slot of layout.slots) {
        expect(slot.y - layout.dieSizePx / 2).toBeGreaterThanOrEqual(tableTop);
        expect(slot.y + layout.dieSizePx / 2).toBeLessThanOrEqual(height);
      }
    }
  });

  it("never sizes a die outside the legible floor and the row ceiling", () => {
    for (const { width, height } of VIEWPORTS) {
      for (const count of [1, 4, 8, 12, 20]) {
        const layout = layoutFor(count, width, height);

        expect(layout.dieSizePx).toBeGreaterThanOrEqual(DIE_MIN_PX);
        expect(layout.dieSizePx).toBeLessThanOrEqual(DIE_SIZE_PX);
        expect(layout.gapPx).toBeLessThanOrEqual(DIE_GAP_PX);
      }
    }
  });

  it("never grows past the row cap", () => {
    for (const { width, height } of VIEWPORTS) {
      for (const count of [1, 4, 8, 12, 20]) {
        const layout = layoutFor(count, width, height);

        expect(layout.rows).toBeLessThanOrEqual(MAX_TABLE_ROWS);
      }
    }
  });

  it("derives the table height from the rows it actually laid out", () => {
    const layout = layoutFor(5, 1376, 900);

    expect(layout.tableHeightPx).toBe(
      TABLE_BOTTOM_PAD_PX * 2 + layout.rows * layout.dieSizePx + (layout.rows - 1) * layout.gapPx,
    );
  });

  it("fills the bottom row before starting the next one", () => {
    const layout = layoutFor(8, 320, 568);

    expect(layout.rows).toBe(2);
    const bottom = layout.slots.filter((s) => s.row === 0);
    const above = layout.slots.filter((s) => s.row === 1);

    expect(bottom).toHaveLength(layout.perRow);
    expect(above.length).toBe(8 - layout.perRow);
    // Dice are placed left to right within a row.
    expect(bottom.map((s) => s.column)).toEqual(bottom.map((_, i) => i));
    // The upper row sits higher than the bottom row.
    expect(Math.min(...above.map((s) => s.y))).toBeLessThan(Math.max(...bottom.map((s) => s.y)));
  });

  it("does not overflow a narrow viewport with a big table", () => {
    const layout = layoutFor(12, 320, 568);
    const widest = Math.max(...layout.slots.map((s) => s.x + layout.dieSizePx / 2));

    expect(widest).toBeLessThanOrEqual(320);
  });

  it("still keeps every die on screen for a roster too big for the strip", () => {
    // Past roughly 40 players at phone width nothing fits the art at the
    // legible die-size floor, so the table grows upward instead. Every die
    // still has to be reachable on screen.
    const layout = layoutFor(40, 320, 568);
    const half = layout.dieSizePx / 2;

    expect(layout.rows).toBeGreaterThan(MAX_TABLE_ROWS);
    expect(layout.slots).toHaveLength(40);
    expect(layout.tableHeightPx).toBeLessThanOrEqual(568);
    for (const slot of layout.slots) {
      expect(slot.y - half).toBeGreaterThanOrEqual(0);
      expect(slot.y + half).toBeLessThanOrEqual(568);
    }
  });
});

describe("tableObstacles (issue #613)", () => {
  it("lists every other slot as an offset from this die's", () => {
    const layout = layoutFor(3, 1376, 900);

    expect(tableObstacles(layout, "player-01")).toHaveLength(2);
  });

  it("never includes the die's own slot", () => {
    const layout = layoutFor(1, 1376, 900);

    expect(tableObstacles(layout, "player-00")).toEqual([]);
  });

  it("returns nothing for a player with no slot", () => {
    const layout = layoutFor(2, 1376, 900);

    expect(tableObstacles(layout, "not-on-the-table")).toEqual([]);
  });

  it("converts viewport pixels into die-space, so a shrunk die still lines up", () => {
    // A big roster on a small phone shrinks the die below its authored size.
    const layout = layoutFor(24, 320, 568);
    const scale = layout.dieSizePx / DIE_SIZE_PX;
    expect(scale).toBeLessThan(1);

    const slot = layout.slots.find((s) => s.playerId === "player-00")!;
    const neighbour = layout.slots.find((s) => s.playerId === "player-01")!;
    const [obstacle] = tableObstacles(layout, "player-00");

    expect(obstacle!.x).toBeCloseTo((neighbour.x - slot.x) / scale);
    expect(obstacle!.z).toBeCloseTo((neighbour.y - slot.y) / scale);
  });
});