"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer } from "@/lib/supabase/players";
import { ROLL_INPUT_MODES, setRollInputMode, type RollInputMode } from "@/lib/supabase/playerSettings";

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
