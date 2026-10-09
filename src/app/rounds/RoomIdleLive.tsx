"use client";

import { useRoomRefresh } from "@/lib/room/roomViewContext";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";

/**
 * Realtime listener for the idle "no active round" / "Start Round" view
 * (issue #98) — this view has no roundId to filter broadcasts on, since no
 * round exists yet, so it passes null to useRoomChannel and picks up every
 * round-started event on the room's channel regardless of which round
 * started it. Renders nothing; just refreshes the server component tree so
 * the page picks up the newly-started round.
 */
export function RoomIdleLive({ roomId }: { roomId: string }) {
  const refresh = useRoomRefresh();

  useRoomChannel(roomId, null, {
    "round-started": () => refresh(),
  });

  return null;
}
