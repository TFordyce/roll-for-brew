import { describe, expect, it } from "vitest";
import { hashString, mulberry32 } from "./deterministicRandom";

describe("hashString", () => {
  it("is stable for the same input", () => {
    expect(hashString("round-1:0:player-2")).toBe(hashString("round-1:0:player-2"));
  });

  it("separates inputs that differ", () => {
    expect(hashString("round-1:0:player-2")).not.toBe(hashString("round-1:0:player-3"));
  });

  it("always returns an unsigned 32-bit integer", () => {
    for (const input of ["", "a", "round-1", "a much longer identifier than the others"]) {
      const seed = hashString(input);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("mulberry32", () => {
  it("replays the same sequence from the same seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const first = Array.from({ length: 8 }, () => a());
    const second = Array.from({ length: 8 }, () => b());

    expect(second).toEqual(first);
  });

  it("produces different sequences from different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);

    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it("stays inside [0, 1)", () => {
    const random = mulberry32(99);
    for (let i = 0; i < 200; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
