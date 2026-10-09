"use client";

import { useRoomRefresh } from "@/lib/room/roomViewContext";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";

/**
 * Realtime listener for the round's "open" (declaring-in) phase — unlike the
 * closed phase (RoundReveal/TieBanner both already subscribe), this phase had
 * no client-side listener at all, so a player sitting on the declare-in view
 * never found out declarations had closed and it was their turn to roll until
 * they manually reloaded. Renders nothing; just refreshes the server
 * component tree so the page picks up the round's new status.
 */
export function RoundOpenLive({ roomId, roundId }: { roomId: string; roundId: string }) {
  const refresh = useRoomRefresh();

  useRoomChannel(roomId, roundId, {
    "round-closed": () => refresh(),
    "round-cancelled": () => refresh(),
    "player-declared-in": () => refresh(),
    "player-withdrew": () => refresh(),
  });

  return null;
}
