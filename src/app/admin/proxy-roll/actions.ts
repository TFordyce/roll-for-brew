"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { adminProxyRoll } from "@/lib/supabase/rolls";
import { advanceRound } from "@/app/rounds/advanceRound";
import { isStaleRoundError } from "@/app/rounds/roundActionHelpers";

export type AdminProxyRollState = { status: "idle" } | { status: "error"; message: string };

export async function adminProxyRollAction(
  _prevState: AdminProxyRollState,
  formData: FormData,
): Promise<AdminProxyRollState> {
  const roundId = formData.get("roundId");
  const playerId = formData.get("playerId");
  const rawValue = formData.get("value");
  const value = typeof rawValue === "string" ? Number(rawValue) : NaN;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("adminProxyRollAction: missing roundId");
  }
  if (typeof playerId !== "string" || !playerId) {
    return { status: "error", message: "Choose which player this roll is for." };
  }
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    return { status: "error", message: "Enter the value they rolled, 1-20." };
  }

  const supabase = await createClient();
  try {
    await adminProxyRoll(supabase, roundId, playerId, value);
  } catch (error) {
    if (isStaleRoundError(error)) {
      revalidatePath("/admin/proxy-roll");
      return { status: "idle" };
    }
    const rawMessage = (error as { message?: string } | null)?.message?.replace(/^[a-z_]+:\s*/, "");
    return {
      status: "error",
      message: rawMessage ? rawMessage.charAt(0).toUpperCase() + rawMessage.slice(1) + "." : "Could not submit that roll.",
    };
  }

  await advanceRound(supabase, roundId, "layerRolled");

  revalidatePath("/admin/proxy-roll");
  revalidatePath("/");
  return { status: "idle" };
}
