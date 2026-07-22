"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { roomChannelName } from "@/lib/supabase/realtime";

/**
 * Realtime listener for the round's "open" (declaring-in) phase — unlike the
 * closed phase (RoundReveal/TieBanner both already subscribe), this phase had
 * no client-side listener at all, so a player sitting on the declare-in view
 * never found out declarations had closed and it was their turn to roll until
 * they manually reloaded. Renders nothing; just refreshes the server
 * component tree so the page picks up the round's new status.
 */
export function RoundOpenLive({ roomId, roundId }: { roomId: string; roundId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(roomChannelName(roomId));

    channel
      .on("broadcast", { event: "round-closed" }, ({ payload }) => {
        const closedPayload = payload as { roundId: string };
        if (closedPayload.roundId !== roundId) return;
        router.refresh();
      })
      .on("broadcast", { event: "round-cancelled" }, ({ payload }) => {
        const cancelledPayload = payload as { roundId: string };
        if (cancelledPayload.roundId !== roundId) return;
        router.refresh();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, roundId, router]);

  return null;
}
