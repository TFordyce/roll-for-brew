"use client";

import { useRouter } from "next/navigation";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";

/**
 * Realtime listener for a round's Menu (issue #227) — picking or changing
 * an Order (OrderPicker.tsx, via notifyOrderChangedAction) previously had no
 * listener anywhere, so RoundMenu went stale until a manual reload. Renders
 * nothing; just refreshes the server component tree, the same way
 * RoundOpenLive/SpellCastLive do for their own concerns.
 */
export function MenuLive({ roomId, roundId }: { roomId: string; roundId: string }) {
  const router = useRouter();

  useRoomChannel(roomId, roundId, {
    "order-changed": () => router.refresh(),
  });

  return null;
}
