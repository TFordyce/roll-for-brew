import type { RoomViewResponse } from "@/lib/api/client";

export type RoomView = RoomViewResponse;

export interface RoomViewStore {
  getSnapshot(): RoomView;
  subscribe(listener: () => void): () => void;
  refetch(): void;
  applyServerView(view: RoomView): void;
}

const versionOf = (view: RoomView) => Number(view.version);

export function createRoomViewStore(opts: {
  initialView: RoomView;
  fetchView: () => Promise<RoomView>;
  onError?: (error: unknown) => void;
}): RoomViewStore {
  let snapshot = opts.initialView;
  let issued = 0;
  let appliedSeq = 0;
  let inFlight = false;
  let dirty = false;
  const listeners = new Set<() => void>();

  function apply(seq: number, view: RoomView) {
    if (seq <= appliedSeq) return;
    if (versionOf(view) < versionOf(snapshot)) return;
    appliedSeq = seq;
    snapshot = view;
    for (const l of listeners) l();
  }

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
