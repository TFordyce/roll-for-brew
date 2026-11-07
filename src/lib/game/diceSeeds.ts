// A roll's throw, derived rather than transmitted.
//
// Every client must watch the same die take the same path for the same roll,
// and nothing about the throw may cross the wire. So the track is a pure
// function of `(roundId, layer, playerId)` — those three already reach every
// client through game state, and the seed is their hash. The round's other dice
// are part of the input too, and they are derived from the same participant
// list on every client, so the caroms agree as well.
//
// The roller's early die and every other client's shared die use this same
// derivation, which is what makes their resting poses agree.

import { hashString, mulberry32 } from "./deterministicRandom";
import { type DiceFlightTrack, type DiceObstacle, simulateD20Throw } from "./dicePhysics";

// A run of a full simulated throw is not free, and the same roll gets asked for
// on every render of the die. Keep a bounded window of the most recent tracks.
const TRACK_CACHE_LIMIT = 64;
const trackCache = new Map<string, DiceFlightTrack>();

export function throwSeed(roundId: string, layer: number, playerId: string): number {
  return hashString(`${roundId}:${layer}:${playerId}`);
}

export function computeThrowTrack(
  seed: number,
  obstacles: readonly DiceObstacle[] = [],
): DiceFlightTrack {
  if (obstacles.length === 0) return simulateD20Throw(mulberry32(seed));
  // The table's slots are anchored to where the throw settles, which is only
  // known once it has been simulated. A first obstacle-free pass finds that
  // point; the second uses the same seed, so the die itself behaves identically.
  const anchor = simulateD20Throw(mulberry32(seed)).restPosition;
  return simulateD20Throw(mulberry32(seed), obstacles, anchor);
}

// Slot offsets are whole or half pixels and the set order is not meaningful, so
// sort and keep them exact: two different tables must never share a cache entry.
function obstacleSignature(obstacles: readonly DiceObstacle[]): string {
  if (obstacles.length === 0) return "";
  return obstacles
    .map((o) => `${o.x},${o.z}`)
    .sort()
    .join(";");
}

export function deriveThrowTrack(
  roundId: string,
  layer: number,
  playerId: string,
  obstacles: readonly DiceObstacle[] = [],
): DiceFlightTrack {
  const key = `${roundId}:${layer}:${playerId}|${obstacleSignature(obstacles)}`;
  const cached = trackCache.get(key);
  if (cached) return cached;

  const track = computeThrowTrack(throwSeed(roundId, layer, playerId), obstacles);
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
