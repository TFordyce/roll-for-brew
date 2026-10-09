"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RoomView } from "@/lib/room/roomViewStore";
import { getCurrentLayerRollerIds, getExpectedLayerRollerIds } from "@/lib/supabase/stall";
import { getInDeckSpellCards, type InDeckSpellCard } from "@/lib/supabase/spellCards";
import { RollForOthers, type PendingRoller } from "@/app/admin/test-room/RollForOthers";

export function LiveRollForOthers({ view }: { view: RoomView }) {
  const { room, viewer } = view;
  const active = room.activeRound;
  const roundId = active?.roundId ?? null;
  const isClosed = active?.status === "closed";
  const layer = active ? Number(active.currentLayer) : 0;
  const [pendingRollers, setPendingRollers] = useState<PendingRoller[]>([]);
  const [inDeckCards, setInDeckCards] = useState<InDeckSpellCard[]>([]);

  useEffect(() => {
    if (!roundId || !isClosed) {
      setPendingRollers([]);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const [expectedIds, rolledIds] = await Promise.all([
        getExpectedLayerRollerIds(supabase, roundId, layer),
        getCurrentLayerRollerIds(supabase, roundId),
      ]);
      const names = new Map(room.roster.map((r) => [r.playerId, r]));
      const pending = [...expectedIds]
        .filter((id) => id !== viewer.playerId && !rolledIds.has(id))
        .map((id) => ({
          playerId: id,
          displayName: names.get(id)?.displayName ?? null,
          email: names.get(id)?.email ?? "",
        }));
      const cards = pending.length > 0 ? await getInDeckSpellCards(supabase, room.roomId) : [];
      if (cancelled) return;
      setPendingRollers(pending);
      setInDeckCards(cards);
    })().catch((error) => console.error("roll-for-others refresh failed", error));
    return () => {
      cancelled = true;
    };
  }, [view, roundId, isClosed, layer, room.roomId, room.roster, viewer.playerId]);

  if (!roundId) return null;
  return <RollForOthers roundId={roundId} pendingRollers={pendingRollers} inDeckCards={inDeckCards} />;
}
