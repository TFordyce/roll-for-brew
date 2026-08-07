"use client";

import { useRouter } from "next/navigation";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";

/**
 * Realtime listener for a round's spell-cast/active-effect state (issue
 * #205) — casting an Action card, filling in a deferred target, or ending
 * another player's active effect early previously had no broadcast at all,
 * so SpellCardPanel's dispellable-effects list, RoundReveal's caster/target/
 * advantage display, and PlayerTile's effect badges all went stale until a
 * manual reload. Renders nothing; just refreshes the server component tree,
 * the same way RoundOpenLive/RoomIdleLive do for their own phases.
 */
export function SpellCastLive({ roomId, roundId }: { roomId: string; roundId: string }) {
  const router = useRouter();

  useRoomChannel(roomId, roundId, {
    "spell-cast-changed": () => router.refresh(),
  });

  return null;
}
