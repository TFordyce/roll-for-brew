"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { coalesceWithinTick } from "./coalesceWithinTick";
import type { RoomView, RoomViewStore } from "./roomViewStore";

const refreshRouter = coalesceWithinTick((router: ReturnType<typeof useRouter>) => router.refresh());

export const RoomViewContext = createContext<RoomViewStore | null>(null);

export function useRoomViewStore(): RoomViewStore | null {
  return useContext(RoomViewContext);
}

export function useRoomView(): RoomView {
  const store = useRoomViewStore();
  if (!store) throw new Error("useRoomView needs a RoomViewProvider");
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useRoomRefresh(): () => void {
  const store = useRoomViewStore();
  const router = useRouter();
  return store ? () => store.refetch() : () => refreshRouter(router);
}
