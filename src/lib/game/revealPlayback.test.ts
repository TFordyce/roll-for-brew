import { describe, expect, it } from "vitest";
import { createPlaybackLedger, playbackKey } from "./revealPlayback";

const ROLL = { roundId: "round-1", layer: 0, playerId: "player-a" };

describe("playbackKey", () => {
  it("distinguishes every part of the triple", () => {
    expect(playbackKey(ROLL)).not.toBe(playbackKey({ ...ROLL, roundId: "round-2" }));
    expect(playbackKey(ROLL)).not.toBe(playbackKey({ ...ROLL, layer: 1 }));
    expect(playbackKey(ROLL)).not.toBe(playbackKey({ ...ROLL, playerId: "player-b" }));
  });
});

describe("createPlaybackLedger", () => {
  it("owes the throw the first time and never again", () => {
    const ledger = createPlaybackLedger();

    expect(ledger.claim(ROLL)).toBe(true);
    expect(ledger.claim(ROLL)).toBe(false);
    expect(ledger.claim(ROLL)).toBe(false);
  });

  it("owes each roll separately", () => {
    const ledger = createPlaybackLedger();

    expect(ledger.claim(ROLL)).toBe(true);
    expect(ledger.claim({ ...ROLL, playerId: "player-b" })).toBe(true);
    expect(ledger.claim({ ...ROLL, layer: 1 })).toBe(true);
    expect(ledger.claim({ ...ROLL, roundId: "round-2" })).toBe(true);
    expect(ledger.size()).toBe(4);
  });

  it("reports what it has already paid out", () => {
    const ledger = createPlaybackLedger();

    expect(ledger.has(ROLL)).toBe(false);
    ledger.claim(ROLL);
    expect(ledger.has(ROLL)).toBe(true);
    expect(ledger.has({ ...ROLL, playerId: "player-b" })).toBe(false);
  });

  it("keeps a bounded window instead of growing forever", () => {
    const ledger = createPlaybackLedger(3);

    for (const playerId of ["a", "b", "c", "d"]) ledger.claim({ ...ROLL, playerId });

    expect(ledger.size()).toBe(3);
    // The oldest claim was dropped; the most recent ones are still held.
    expect(ledger.has({ ...ROLL, playerId: "a" })).toBe(false);
    expect(ledger.has({ ...ROLL, playerId: "d" })).toBe(true);
  });

  it("still owes a throw with a one-slot window", () => {
    const ledger = createPlaybackLedger(1);

    expect(ledger.claim(ROLL)).toBe(true);
    expect(ledger.claim(ROLL)).toBe(false);
    expect(ledger.size()).toBe(1);
  });
});
