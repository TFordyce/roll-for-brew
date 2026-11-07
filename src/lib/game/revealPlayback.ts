// "Every roll's die plays exactly once per client."
//
// The reveal reaches a client more than once — `layer-rolls-revealed` and
// `round-revealed` both carry the same rolls, and a room-view refetch re-renders
// around them. This ledger is the single place that decides whether a given
// roll still owes the viewer a throw, so a duplicate delivery can never restart
// a die that has already landed.

export type PlaybackTarget = {
  readonly roundId: string;
  readonly layer: number;
  readonly playerId: string;
};

export type PlaybackLedger = {
  /** True only for the first claim of this roll; false for every repeat. */
  claim: (target: PlaybackTarget) => boolean;
  has: (target: PlaybackTarget) => boolean;
  size: () => number;
};

const DEFAULT_LEDGER_LIMIT = 512;

export function playbackKey(target: PlaybackTarget): string {
  return `${target.roundId}:${target.layer}:${target.playerId}`;
}

export function createPlaybackLedger(limit: number = DEFAULT_LEDGER_LIMIT): PlaybackLedger {
  const bound = Math.max(1, Math.floor(limit));
  const claimed = new Set<string>();

  return {
    claim(target) {
      const key = playbackKey(target);
      if (claimed.has(key)) return false;
      claimed.add(key);
      if (claimed.size > bound) {
        // Drop the oldest claim, so a long session cannot grow this forever.
        // A roll that falls out this far behind can never be re-delivered.
        const oldest = claimed.values().next().value;
        if (oldest !== undefined) claimed.delete(oldest);
      }
      return true;
    },
    has: (target) => claimed.has(playbackKey(target)),
    size: () => claimed.size,
  };
}
