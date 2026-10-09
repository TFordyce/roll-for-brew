"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { RoomView, RoomViewStore } from "./roomViewStore";

export const RoomViewContext = createContext<RoomViewStore | null>(null);

/** The room view store, or null on the legacy (flag off) page. */
export function useRoomViewStore(): RoomViewStore | null {
  return useContext(RoomViewContext);
}

/** The current room view. Only callable under a RoomViewProvider. */
export function useRoomView(): RoomView {
  const store = useRoomViewStore();
  if (!store) throw new Error("useRoomView needs a RoomViewProvider");
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * How a live panel asks the page to catch up: refetch the room view when one is mounted (flag on),
 * else `router.refresh()` as before. Panels call this instead of `router.refresh()` directly.
 */
export function useRoomRefresh(): () => void {
  const store = useRoomViewStore();
  const router = useRouter();
  return store ? () => store.refetch() : () => router.refresh();
}
