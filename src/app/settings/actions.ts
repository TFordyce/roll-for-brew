"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { ROLL_INPUT_MODES, setRollInputMode, type RollInputMode } from "@/lib/supabase/playerSettings";

export async function updateRollInputModeAction(formData: FormData) {
  const mode = formData.get("rollInputMode");
  if (typeof mode !== "string" || !ROLL_INPUT_MODES.includes(mode as RollInputMode)) {
    throw new Error("updateRollInputModeAction: invalid rollInputMode");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("updateRollInputModeAction: not authenticated");
  }

  await setRollInputMode(supabase, googlePlayerId(user), mode as RollInputMode);
  revalidatePath("/settings");
}
