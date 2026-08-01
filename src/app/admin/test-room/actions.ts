"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { setActingAs, endTestSession } from "@/lib/supabase/actingAs";

/**
 * Switches which seeded Test Player (or the admin's own real identity) the
 * caller is currently Acting As (issue #102). set_acting_as itself re-checks
 * is_admin server-side, so posting directly to this action as a non-admin
 * is rejected by the RPC rather than trusted from the form.
 */
export async function setActingAsAction(formData: FormData): Promise<void> {
  const targetPlayerId = formData.get("targetPlayerId");
  if (typeof targetPlayerId !== "string" || !targetPlayerId) {
    throw new Error("setActingAsAction: missing targetPlayerId");
  }

  const supabase = await createClient();
  await setActingAs(supabase, targetPlayerId);
  revalidatePath("/admin/test-room");
}

/**
 * Clears the Test Room's accumulated rounds/rolls/casts/effects, leaving the
 * room and its seeded roster ready for next time (issue #102).
 */
export async function endTestSessionAction(): Promise<void> {
  const supabase = await createClient();
  await endTestSession(supabase);
  revalidatePath("/admin/test-room");
}
