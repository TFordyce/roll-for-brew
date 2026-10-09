"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { apiClientFor } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";
import { enforceStall } from "@/app/rounds/enforceStall";
import { subscribeRoomViewStore } from "./roomViewChannel";
import { RoomViewContext, useRoomView } from "./roomViewContext";
import { createRoomViewStore, type RoomView } from "./roomViewStore";

const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const DEADLINE_SLACK_MS = 1_000;

export function RoomViewProvider({
  roomId,
  initialView,
  children,
}: {
  roomId: string;
  initialView: RoomView;
  children: ReactNode;
}) {
  const [store] = useState(() =>
    createRoomViewStore({
      initialView,
      fetchView: () => apiClientFor(createClient()).getRoomView(roomId),
      onError: (error) => console.error("room view refetch failed", error),
    }),
  );

  const seeded = useRef(initialView);
  useEffect(() => {
    if (seeded.current === initialView) return;
    seeded.current = initialView;
    store.applyServerView(initialView);
  }, [initialView, store]);

  const resync = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let running = false;
    let again = false;
    resync.current = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          try {
            await enforceStall(roomId);
          } catch (error) {
            console.error("enforceStall failed", error);
          }
        } while (again);
      } finally {
        running = false;
      }
      store.refetch();
    };

    const unsubscribe = subscribeRoomViewStore(createClient(), roomId, store, {
      onResubscribe: () => void resync.current(),
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") void resync.current();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [roomId, store]);

  return (
    <RoomViewContext.Provider value={store}>
      <StallDeadlineTimer resync={resync} />
      {children}
    </RoomViewContext.Provider>
  );
}

function StallDeadlineTimer({ resync }: { resync: RefObject<() => Promise<void>> }) {
  const { nextStallDeadline, dbNow } = useRoomView().room;

  useEffect(() => {
    if (!nextStallDeadline) return;
    const untilDeadline = Date.parse(nextStallDeadline) - Date.parse(dbNow);
    const delay = Math.min(Math.max(untilDeadline, 0) + DEADLINE_SLACK_MS, MAX_TIMER_MS);
    const timer = setTimeout(() => void resync.current(), delay);
    return () => clearTimeout(timer);
  }, [nextStallDeadline, dbNow, resync]);

  return null;
}
