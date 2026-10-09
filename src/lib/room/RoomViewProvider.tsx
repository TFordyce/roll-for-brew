"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiClientFor } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";
import { enforceStall } from "@/app/rounds/enforceStall";
import { subscribeRoomViewStore } from "./roomViewChannel";
import { RoomViewContext, useRoomView } from "./roomViewContext";
import { createRoomViewStore, type RoomView } from "./roomViewStore";

// setTimeout runs immediately past 2^31-1 ms; a deadline further out re-arms when this fires.
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
// Wait a beat past the deadline so the server clock has also crossed it.
const DEADLINE_SLACK_MS = 1_000;

/**
 * Holds the room view for a flagged room (spec #533, slice 1c). The server component supplies
 * `initialView` (and a fresh one after any `router.refresh()`); everything after that is a
 * refetch, triggered by the room channel, a resubscribe, the tab becoming visible, or the
 * `nextStallDeadline` timer. No polling, no `router.refresh()`.
 */
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

  // A new server render (router.refresh after an action, an Acting As switch) is offered to the store.
  const seeded = useRef(initialView);
  useEffect(() => {
    if (seeded.current === initialView) return;
    seeded.current = initialView;
    store.applyServerView(initialView);
  }, [initialView, store]);

  // Stall sweep, then refetch to show what it changed. One at a time: mount, the first
  // SUBSCRIBED and a visibility flip can all land together.
  const resync = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let running = false;
    resync.current = async () => {
      if (running) return;
      running = true;
      try {
        await enforceStall(roomId);
      } catch (error) {
        console.error("enforceStall failed", error);
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
    void resync.current();

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [roomId, store]);

  return (
    <RoomViewContext.Provider value={store}>
      <StallDeadlineTimer resync={() => resync.current()} />
      {children}
    </RoomViewContext.Provider>
  );
}

/** Fires a resync when the view's `nextStallDeadline` passes. Measured against the server's `dbNow`, not this device's clock. */
function StallDeadlineTimer({ resync }: { resync: () => Promise<void> }) {
  const { nextStallDeadline, dbNow } = useRoomView().room;

  useEffect(() => {
    if (!nextStallDeadline) return;
    const untilDeadline = Date.parse(nextStallDeadline) - Date.parse(dbNow);
    const delay = Math.min(Math.max(untilDeadline, 0) + DEADLINE_SLACK_MS, MAX_TIMER_MS);
    const timer = setTimeout(() => void resync(), delay);
    return () => clearTimeout(timer);
    // resync is a stable ref-reader; the timer re-arms only when the view's clock changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextStallDeadline, dbNow]);

  return null;
}
