"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer } from "@/lib/supabase/players";
import { getActiveRound } from "@/lib/supabase/rounds";
import { autoDeclineStalledRoundReplays } from "@/lib/supabase/roundReplay";
import { enforceStallTimeout } from "@/app/rounds/stallEnforcement";

export async function enforceStall(roomId: string): Promise<void> {
  const supabase = await createClient();
  if (!(await getCurrentPlayer(supabase))) return;

  await autoDeclineStalledRoundReplays(supabase);
  const activeRound = await getActiveRound(supabase, roomId);
  if (activeRound) await enforceStallTimeout(supabase, activeRound.id);
}
