import { describe, expect, it } from "vitest";
import { getSlotAssignments, PROP_KEYS } from "./backdropShuffle";

describe("getSlotAssignments", () => {
  it("returns all 8 prop keys exactly once", () => {
    const slots = getSlotAssignments("player-1", new Date("2026-07-23T12:00:00Z"));
    expect(slots).toHaveLength(PROP_KEYS.length);
    expect(new Set(slots)).toEqual(new Set(PROP_KEYS));
  });

  it("is stable for the same player and calendar day", () => {
    const a = getSlotAssignments("player-1", new Date("2026-07-23T01:00:00Z"));
    const b = getSlotAssignments("player-1", new Date("2026-07-23T23:00:00Z"));
    expect(a).toEqual(b);
  });

  it("changes for the same player on a different day", () => {
    const day1 = getSlotAssignments("player-1", new Date("2026-07-23T12:00:00Z"));
    const day2 = getSlotAssignments("player-1", new Date("2026-07-24T12:00:00Z"));
    expect(day1).not.toEqual(day2);
  });

  it("differs independently across players on the same day", () => {
    const date = new Date("2026-07-23T12:00:00Z");
    const a = getSlotAssignments("player-1", date);
    const b = getSlotAssignments("player-2", date);
    expect(a).not.toEqual(b);
  });

  it("is deterministic across repeated calls", () => {
    const date = new Date("2026-07-23T12:00:00Z");
    const a = getSlotAssignments("player-1", date);
    const b = getSlotAssignments("player-1", date);
    expect(a).toEqual(b);
  });
});
