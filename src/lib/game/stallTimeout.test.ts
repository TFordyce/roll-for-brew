import { describe, expect, it } from "vitest";
import { STALL_TIMEOUT_MS, hasStalled } from "./stallTimeout";

describe("hasStalled", () => {
  it("is false before the timeout has elapsed", () => {
    const since = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const now = new Date(new Date(since).getTime() + STALL_TIMEOUT_MS - 1);
    expect(hasStalled(since, now)).toBe(false);
  });

  it("is true once the timeout has elapsed", () => {
    const since = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const now = new Date(new Date(since).getTime() + STALL_TIMEOUT_MS);
    expect(hasStalled(since, now)).toBe(true);
  });

  it("is true well past the timeout", () => {
    const since = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const now = new Date(new Date(since).getTime() + STALL_TIMEOUT_MS * 10);
    expect(hasStalled(since, now)).toBe(true);
  });
});
