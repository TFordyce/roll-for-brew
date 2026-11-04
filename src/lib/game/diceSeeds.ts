// A roll's throw, derived rather than transmitted.
//
// Every client must watch the same die take the same path for the same roll,
// and nothing about the throw may cross the wire. So the track is a pure
// function of `(roundId, layer, playerId)`: those three already reach every
// client through game state, and the seed is their hash.
//
// The roller's early die and every other client's shared die use this same
// derivation, which is what makes their resting poses agree.

import { hashString, mulberry32 } from "./deterministicRandom";
import { type DiceFlightTrack, simulateD20Throw } from "./dicePhysics";

// A run of a full simulated throw is not free, and the same roll gets asked for
// on every render of the die. Keep a bounded window of the most recent tracks.
const TRACK_CACHE_LIMIT = 64;
const trackCache = new Map<string, DiceFlightTrack>();

export function throwSeed(roundId: string, layer: number, playerId: string): number {
  return hashString(`${roundId}:${layer}:${playerId}`);
}

export function computeThrowTrack(seed: number): DiceFlightTrack {
  return simulateD20Throw(mulberry32(seed));
}

export function deriveThrowTrack(
  roundId: string,
  layer: number,
  playerId: string,
): DiceFlightTrack {
  const key = `${roundId}:${layer}:${playerId}`;
  const cached = trackCache.get(key);
  if (cached) return cached;

  const track = computeThrowTrack(throwSeed(roundId, layer, playerId));
  if (trackCache.size >= TRACK_CACHE_LIMIT) {
    const oldest = trackCache.keys().next().value;
    if (oldest !== undefined) trackCache.delete(oldest);
  }
  trackCache.set(key, track);
  return track;
}

/** Test seam: forget cached tracks so derivations can be compared from scratch. */
export function clearThrowTrackCache(): void {
  trackCache.clear();
}
