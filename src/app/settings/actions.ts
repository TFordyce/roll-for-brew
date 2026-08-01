"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { ROLL_INPUT_MODES, setRollInputMode, type RollInputMode } from "@/lib/supabase/playerSettings";
import { setAdminModeEnabled } from "@/lib/supabase/adminMode";

export type UpdateRollInputModeState = { status: "idle" } | { status: "saved" };

export async function updateRollInputModeAction(
  _prevState: UpdateRollInputModeState,
  formData: FormData,
): Promise<UpdateRollInputModeState> {
  const mode = formData.get("rollInputMode");
  if (typeof mode !== "string" || !ROLL_INPUT_MODES.includes(mode as RollInputMode)) {
    throw new Error("updateRollInputModeAction: invalid rollInputMode");
  }

  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);
  if (!current) {
    throw new Error("updateRollInputModeAction: not authenticated");
  }

  await setRollInputMode(supabase, current.playerId, mode as RollInputMode);
  revalidatePath("/settings");
  return { status: "saved" };
}

/**
 * Sets/clears the Admin Mode cookie (never a DB write — see
 * src/lib/supabase/adminMode.ts). Re-checks is_admin server-side rather than
 * trusting the form, so a non-admin can't grant themselves the cookie by
 * posting directly to this action.
 */
export async function setAdminModeAction(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);
  if (!current) {
    throw new Error("setAdminModeAction: not authenticated");
  }

  const isAdmin = await getIsAdmin(supabase, current.playerId);
  if (!isAdmin) {
    throw new Error("setAdminModeAction: caller is not an admin");
  }

  await setAdminModeEnabled(formData.get("adminMode") === "true");
  revalidatePath("/settings");
  revalidatePath("/");
}
