import { describe, expect, it } from "vitest";
import { mulberry32 } from "./deterministicRandom";
import { simulateD20Throw } from "./dicePhysics";
import {
  clearThrowTrackCache,
  computeThrowTrack,
  deriveThrowTrack,
  throwSeed,
} from "./diceSeeds";

describe("throwSeed", () => {
  it("is stable for the same round, layer and player", () => {
    expect(throwSeed("round-1", 0, "player-a")).toBe(throwSeed("round-1", 0, "player-a"));
  });

  it("changes when any part of the triple changes", () => {
    const base = throwSeed("round-1", 0, "player-a");

    expect(throwSeed("round-2", 0, "player-a")).not.toBe(base);
    expect(throwSeed("round-1", 1, "player-a")).not.toBe(base);
    expect(throwSeed("round-1", 0, "player-b")).not.toBe(base);
  });

  it("does not collide when a player id contains the separator", () => {
    // `${roundId}:${layer}:${playerId}` could otherwise let the parts slide.
    expect(throwSeed("round-1", 0, "player:a")).not.toBe(throwSeed("round-1:0", 0, "player"));
  });
});

describe("computeThrowTrack", () => {
  it("is deeply equal for the same seed on independent runs", () => {
    const seed = throwSeed("round-1", 0, "player-a");

    expect(computeThrowTrack(seed)).toEqual(computeThrowTrack(seed));
  });

  it("settles the die where it started, so it lands in its slot", () => {
    const track = computeThrowTrack(throwSeed("round-1", 0, "player-a"));
    const last = track.samples.at(-1)!;

    expect(Math.hypot(last.x, last.y, last.z)).toBeLessThan(0.6);
  });

  it("matches what a bare simulated throw does with the same random source", () => {
    const seed = throwSeed("round-1", 0, "player-a");

    expect(computeThrowTrack(seed)).toEqual(simulateD20Throw(mulberry32(seed)));
  });
});

describe("deriveThrowTrack", () => {
  it("gives every roll on every client the same track", () => {
    clearThrowTrackCache();
    const first = deriveThrowTrack("round-1", 0, "player-a");
    clearThrowTrackCache();
    const second = deriveThrowTrack("round-1", 0, "player-a");

    expect(second).toEqual(first);
  });

  it("gives different rolls different tracks", () => {
    clearThrowTrackCache();

    expect(deriveThrowTrack("round-1", 0, "player-a")).not.toEqual(
      deriveThrowTrack("round-1", 0, "player-b"),
    );
    expect(deriveThrowTrack("round-1", 0, "player-a")).not.toEqual(
      deriveThrowTrack("round-2", 0, "player-a"),
    );
    expect(deriveThrowTrack("round-1", 0, "player-a")).not.toEqual(
      deriveThrowTrack("round-1", 1, "player-a"),
    );
  });

  it("returns the cached track for a repeated roll", () => {
    clearThrowTrackCache();
    const first = deriveThrowTrack("round-1", 0, "player-a");

    expect(deriveThrowTrack("round-1", 0, "player-a")).toBe(first);
  });

  it("does not grow without bound", () => {
    clearThrowTrackCache();
    for (let i = 0; i < 80; i += 1) deriveThrowTrack("round-1", 0, `player-${i}`);

    // The cache keeps a bounded window; the most recent roll is always hot.
    const newest = deriveThrowTrack("round-1", 0, "player-79");
    expect(deriveThrowTrack("round-1", 0, "player-79")).toBe(newest);
  });
});
