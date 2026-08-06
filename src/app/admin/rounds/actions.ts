"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { adminDeleteRound } from "@/lib/supabase/adminRounds";

export type DeleteRoundState = { status: "idle" } | { status: "error"; message: string };

/**
 * Deletes an invalid round (issue #189), keyed off the RFB16/RFB17/RFB18
 * error codes admin_delete_round raises (0055_admin_delete_round.sql) — same
 * "strip the RPC's own prefix, surface the rest" handling
 * allocateSpellCardAction (src/app/admin/cards/actions.ts) already models.
 */
export async function deleteRoundAction(
  _prevState: DeleteRoundState,
  formData: FormData,
): Promise<DeleteRoundState> {
  const roundId = formData.get("roundId");
  const reason = formData.get("reason");

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("deleteRoundAction: missing roundId");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    return { status: "error", message: "A reason is required." };
  }

  const supabase = await createClient();
  try {
    await adminDeleteRound(supabase, roundId, reason);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "RFB16" || code === "RFB17" || code === "RFB18") {
      const rawMessage = (error as { message?: string } | null)?.message ?? "";
      const message = rawMessage.replace(/^admin_delete_round:\s*/, "");
      return {
        status: "error",
        message: message ? message.charAt(0).toUpperCase() + message.slice(1) + "." : "Could not delete that round.",
      };
    }
    throw error;
  }

  revalidatePath("/admin/rounds");
  return { status: "idle" };
}
