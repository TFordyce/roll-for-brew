"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { adminDeleteModifierAdjustment } from "@/lib/supabase/modifierAdjustments";

export type DeleteAdjustmentState = { status: "idle" } | { status: "error"; message: string };

/**
 * Deletes any modifier adjustment (issue #191), keyed off the RFB19/RFB20/
 * RFB21 error codes admin_delete_modifier_adjustment raises
 * (0056_admin_delete_modifier_adjustment.sql) -- same "strip the RPC's own
 * prefix, surface the rest" handling deleteRoundAction
 * (src/app/admin/rounds/actions.ts) already models.
 */
export async function deleteAdjustmentAction(
  _prevState: DeleteAdjustmentState,
  formData: FormData,
): Promise<DeleteAdjustmentState> {
  const adjustmentId = formData.get("adjustmentId");
  const reason = formData.get("reason");

  if (typeof adjustmentId !== "string" || !adjustmentId) {
    throw new Error("deleteAdjustmentAction: missing adjustmentId");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    return { status: "error", message: "A reason is required." };
  }

  const supabase = await createClient();
  try {
    await adminDeleteModifierAdjustment(supabase, adjustmentId, reason);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "RFB19" || code === "RFB20" || code === "RFB21") {
      const rawMessage = (error as { message?: string } | null)?.message ?? "";
      const message = rawMessage.replace(/^admin_delete_modifier_adjustment:\s*/, "");
      return {
        status: "error",
        message: message ? message.charAt(0).toUpperCase() + message.slice(1) + "." : "Could not delete that adjustment.",
      };
    }
    throw error;
  }

  revalidatePath("/admin/adjustments");
  return { status: "idle" };
}
