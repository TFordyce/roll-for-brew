"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer } from "@/lib/supabase/players";
import { getActiveRound } from "@/lib/supabase/rounds";
import { autoDeclineStalledRoundReplays } from "@/lib/supabase/roundReplay";
import { enforceStallTimeout } from "@/app/rounds/stallEnforcement";

/**
 * Interim stall enforcement for the room-view path (spec #533, slice 1c). `GET /rooms/{id}/view`
 * only reads, so the lazy check-on-read sweeps that page.tsx runs on every render (the round's
 * stall timeout, and auto-declining a stale Round Replay decision) run here instead. The room view
 * store calls this on mount, on resync and when `nextStallDeadline` passes, then refetches.
 * Retired when the API's StallCheck lands (slice 7).
 */
export async function enforceStall(roomId: string): Promise<void> {
  const supabase = await createClient();
  if (!(await getCurrentPlayer(supabase))) return;

  await autoDeclineStalledRoundReplays(supabase);
  const activeRound = await getActiveRound(supabase, roomId);
  if (activeRound) await enforceStallTimeout(supabase, activeRound.id);
}
