import type { RoomViewResponse } from "@/lib/api/client";

export type RoomView = RoomViewResponse;

export interface RoomViewStore {
  getSnapshot(): RoomView;
  subscribe(listener: () => void): () => void;
  /** Ask for a fresh view. Calls made while a fetch is in flight coalesce into one follow-up. */
  refetch(): void;
  /**
   * Offer a view the server component rendered (first paint, or after a `router.refresh()` such as an
   * Acting As switch). Ranked as the newest request so far, then held to the same version rule.
   */
  applyServerView(view: RoomView): void;
}

// The API sends the int64 `version` as a number or, past 2^53, a string.
const versionOf = (view: RoomView) => Number(view.version);

export function createRoomViewStore(opts: {
  initialView: RoomView;
  fetchView: () => Promise<RoomView>;
  /** A failed fetch keeps the current view; this is told why. */
  onError?: (error: unknown) => void;
}): RoomViewStore {
  let snapshot = opts.initialView;
  let issued = 0;
  let appliedSeq = 0;
  let inFlight = false;
  let dirty = false;
  const listeners = new Set<() => void>();

  /** A response lands only if its request is newer than the last applied one and its version is not lower. */
  function apply(seq: number, view: RoomView) {
    if (seq <= appliedSeq) return;
    if (versionOf(view) < versionOf(snapshot)) return;
    appliedSeq = seq;
    snapshot = view;
    for (const l of listeners) l();
  }

  /** One fetch at a time; asks that arrive meanwhile set `dirty` and share a single follow-up. */
  async function run() {
    inFlight = true;
    try {
      do {
        dirty = false;
        const seq = ++issued;
        try {
          apply(seq, await opts.fetchView());
        } catch (error) {
          opts.onError?.(error);
        }
      } while (dirty);
    } finally {
      inFlight = false;
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refetch() {
      if (inFlight) dirty = true;
      else void run();
    },
    applyServerView(view) {
      apply(++issued, view);
    },
  };
}
