"use client";

import { useRoomRefresh } from "@/lib/room/roomViewContext";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";

export function RoundOpenLive({ roomId, roundId }: { roomId: string; roundId: string }) {
  const refresh = useRoomRefresh();

  useRoomChannel(roomId, roundId, {
    "room-changed": () => refresh(),
  });

  return null;
}
