"use client";

import { useRoomRefresh } from "@/lib/room/roomViewContext";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";

export function RoomIdleLive({ roomId }: { roomId: string }) {
  const refresh = useRoomRefresh();

  useRoomChannel(roomId, null, {
    "room-changed": () => refresh(),
  });

  return null;
}
