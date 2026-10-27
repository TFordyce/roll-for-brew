import { describe, expect, it } from "vitest";
import {
  FLIGHT_BUDGET_MS,
  SETTLE_TAIL_MS,
  flightWaapiKeyframes,
  settleWaapiKeyframes,
  simulateD20Throw,
  type DiceFlightTrack,
} from "./dicePhysics";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Airborne episodes (>2px above the rest height, >=2 samples): the throw is
// the first, each rebound another.
function airborneEpisodes(track: DiceFlightTrack): number {
  let episodes = 0;
  let run = 0;
  for (const s of track.samples) {
    if (s.y < -2) {
      run += 1;
      if (run === 2) episodes += 1;
    } else {
      run = 0;
    }
  }
  return episodes;
}

describe("simulateD20Throw (issue #606)", () => {
  it("throws the die and brings it to rest within the flight budget", () => {
    const track = simulateD20Throw(mulberry32(1));

    expect(track.samples.length).toBeGreaterThanOrEqual(2);
    const times = track.samples.map((s) => s.tMs);
    expect(times.every((t, i) => i === 0 || t > times[i - 1]!)).toBe(true);
    expect(track.durationMs).toBeLessThanOrEqual(FLIGHT_BUDGET_MS);
    expect(track.restAchieved).toBe(true);

    const [first, last] = [track.samples[0]!, track.samples.at(-1)!];
    // px, relative to the die slot: the die ends where it started sitting
    expect(Math.hypot(last.x, last.y, last.z)).toBeLessThan(0.6);
    // the throw starts airborne, above the slot
    expect(first.y).toBeLessThan(-45);

    const restSpeed = Math.hypot(
      last.x - track.samples.at(-2)!.x,
      last.y - track.samples.at(-2)!.y,
      last.z - track.samples.at(-2)!.z,
    );
    expect(restSpeed).toBeLessThan(0.3);
  });

  it("keeps the whole choreography under the two-second settle decision from spec #600", () => {
    expect(FLIGHT_BUDGET_MS + SETTLE_TAIL_MS).toBeLessThan(2000);
  });

  it("is deterministic for a given random source and unique per roll", () => {
    const a = simulateD20Throw(mulberry32(7));
    const b = simulateD20Throw(mulberry32(7));
    const c = simulateD20Throw(mulberry32(8));

    expect(b.samples).toEqual(a.samples);
    expect(c.samples).not.toEqual(a.samples);
    expect(c.restQuaternion).not.toEqual(a.restQuaternion);
  });

  it("throws in from above and slightly to the side, not from far across the table", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const first = simulateD20Throw(mulberry32(seed)).samples[0]!;
      expect(first.y).toBeLessThan(-45);
      expect(Math.hypot(first.x, first.z)).toBeLessThan(110);
    }
  });

  it("bounces in flight for most throws, and always ends the track still", () => {
    let bounced = 0;
    const seeds = 50;
    for (let seed = 1; seed <= seeds; seed += 1) {
      const track = simulateD20Throw(mulberry32(seed));
      if (airborneEpisodes(track) >= 2) bounced += 1;
      const lastStep = Math.hypot(
        track.samples.at(-1)!.x - track.samples.at(-2)!.x,
        track.samples.at(-1)!.y - track.samples.at(-2)!.y,
        track.samples.at(-1)!.z - track.samples.at(-2)!.z,
      );
      // the handover to the settle tail is always a still die
      expect(lastStep).toBeLessThan(1);
    }
    // glancing landings legitimately absorb the bounce into spin; the settle
    // tail guarantees every choreography still ends with a visible snap
    expect(bounced / seeds).toBeGreaterThan(0.8);
  });

  it("stays finite and near the slot, with unit quaternions throughout", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const track = simulateD20Throw(mulberry32(seed));
      for (const s of track.samples) {
        expect(Number.isFinite(s.x + s.y + s.z + s.qx + s.qy + s.qz + s.qw)).toBe(true);
        expect(Math.abs(s.x)).toBeLessThan(120);
        expect(Math.abs(s.z)).toBeLessThan(120);
        expect(s.y).toBeGreaterThan(-90);
        // hard impacts can dip a couple of px past the rest height for one
        // 60Hz frame before the solver pushes back — invisible in playback
        expect(s.y).toBeLessThanOrEqual(4);
        expect(Math.hypot(s.qx, s.qy, s.qz, s.qw)).toBeCloseTo(1, 5);
      }
      expect(Math.hypot(...track.restQuaternion)).toBeCloseTo(1, 5);
    }
  });
});

type ParsedTransform = { tx: number; ty: number; tz: number; m: number[] };

function parseTransform(transform: string): ParsedTransform {
  const translate = /translate3d\(([-\d.e]+)px,\s*([-\d.e]+)px,\s*([-\d.e]+)px\)/.exec(transform);
  const matrix = /matrix3d\(([^)]+)\)/.exec(transform);
  expect(translate, transform).toBeTruthy();
  expect(matrix, transform).toBeTruthy();
  const m = matrix![1]!.split(",").map((n) => Number(n.trim()));
  expect(m.length).toBe(16);
  return { tx: Number(translate![1]), ty: Number(translate![2]), tz: Number(translate![3]), m };
}

// Rotation angle of the rotation block of a CSS matrix3d (columns 0-2)
function rotationAngle({ m }: ParsedTransform): number {
  const trace = m[0]! + m[5]! + m[10]!;
  return Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2)));
}

function isRotationBlock(m: number[]): boolean {
  // columns are unit length and mutually orthogonal (a pure rotation)
  const col = (i: number) => [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
  const dot3 = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  return (
    [0, 1, 2].every((i) => Math.abs(Math.hypot(...col(i)) - 1) < 1e-9) &&
    Math.abs(dot3(col(0), col(1))) < 1e-9 &&
    Math.abs(dot3(col(0), col(2))) < 1e-9 &&
    Math.abs(dot3(col(1), col(2))) < 1e-9
  );
}

describe("flightWaapiKeyframes", () => {
  it("maps the sampled track one-to-one onto offset + transform keyframes", () => {
    const track = simulateD20Throw(mulberry32(3));
    const keyframes = flightWaapiKeyframes(track);

    expect(keyframes.length).toBe(track.samples.length);
    expect(keyframes[0]!.offset).toBe(0);
    expect(keyframes.at(-1)!.offset).toBe(1);
    for (let i = 1; i < keyframes.length; i += 1) {
      expect(keyframes[i]!.offset!).toBeGreaterThan(keyframes[i - 1]!.offset!);
    }

    const first = parseTransform(keyframes[0]!.transform!);
    expect(first.tx).toBeCloseTo(track.samples[0]!.x, 6);
    expect(first.ty).toBeCloseTo(track.samples[0]!.y, 6);
    expect(first.tz).toBeCloseTo(track.samples[0]!.z, 6);

    const last = parseTransform(keyframes.at(-1)!.transform!);
    expect(last.tx).toBeCloseTo(track.samples.at(-1)!.x, 6);
    expect(last.ty).toBeCloseTo(track.samples.at(-1)!.y, 6);
    expect(last.tz).toBeCloseTo(track.samples.at(-1)!.z, 6);

    // the die visibly tumbles: first and rest orientations differ
    expect(rotationAngle(first)).toBeGreaterThan(0.1);
    expect(isRotationBlock(first.m)).toBe(true);
    expect(isRotationBlock(last.m)).toBe(true);
  });
});

describe("settleWaapiKeyframes", () => {
  it("snaps the resting pose onto the value face with a final hop, ending at identity", () => {
    const track = simulateD20Throw(mulberry32(3));
    const keyframes = settleWaapiKeyframes(track);

    expect(keyframes.length).toBe(3);

    const first = parseTransform(keyframes[0]!.transform!);
    expect(first.tx).toBe(0);
    expect(first.ty).toBe(0);
    expect(first.tz).toBe(0);
    expect(isRotationBlock(first.m)).toBe(true);
    expect(rotationAngle(first)).toBeGreaterThan(0.05);

    const mid = keyframes[1]!;
    expect(mid.offset!).toBeGreaterThan(0.3);
    expect(mid.offset!).toBeLessThan(0.8);
    const midParsed = parseTransform(mid.transform!);
    expect(midParsed.ty).toBeLessThan(-1); // the settle hop lifts the die
    expect(isRotationBlock(midParsed.m)).toBe(true);

    const last = parseTransform(keyframes.at(-1)!.transform!);
    expect(keyframes.at(-1)!.offset).toBe(1);
    expect(last.tx).toBe(0);
    expect(last.ty).toBe(0);
    expect(last.tz).toBe(0);
    // identity rotation: exactly the value-face-front rest pose DieFaces draws
    expect(rotationAngle(last)).toBeCloseTo(0, 9);

    // the mid pose overshoots identity along the same snap, not a new direction
    expect(rotationAngle(midParsed)).toBeLessThan(rotationAngle(first));
  });
});
