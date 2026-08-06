"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { ROLL_INPUT_MODES, setRollInputMode, type RollInputMode } from "@/lib/supabase/playerSettings";
import { setAdminModeEnabled } from "@/lib/supabase/adminMode";
import { deleteModifierAdjustment, logModifierAdjustment } from "@/lib/supabase/modifierAdjustments";

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

export type LogModifierAdjustmentState = { status: "idle" } | { status: "error"; message: string };

/**
 * Logs a Modifier Adjustment (issue #183). Client-side validation (required
 * fields, a `!= 0` number input) makes most bad submissions impossible, but
 * the RFB10/RFB11/RFB12 codes log_modifier_adjustment (0052) raises are
 * re-checked here anyway and surfaced as friendly messages — same "block,
 * don't crash" shape as allocateSpellCardAction's RFB07/RFB08 handling.
 */
export async function logModifierAdjustmentAction(
  _prevState: LogModifierAdjustmentState,
  formData: FormData,
): Promise<LogModifierAdjustmentState> {
  const targetPlayerId = formData.get("targetPlayerId");
  const rawDelta = formData.get("delta");
  const reason = formData.get("reason");

  if (typeof targetPlayerId !== "string" || !targetPlayerId) {
    return { status: "error", message: "Choose who this adjustment is for." };
  }
  const delta = typeof rawDelta === "string" ? Number(rawDelta) : NaN;
  if (!Number.isInteger(delta) || delta === 0) {
    return { status: "error", message: "Enter a non-zero whole number." };
  }
  if (typeof reason !== "string" || !reason.trim()) {
    return { status: "error", message: "A reason is required." };
  }

  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);
  if (!current) {
    throw new Error("logModifierAdjustmentAction: not authenticated");
  }

  try {
    await logModifierAdjustment(supabase, targetPlayerId, delta, reason);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "RFB10") return { status: "error", message: "Enter a non-zero whole number." };
    if (code === "RFB11") return { status: "error", message: "A reason is required." };
    if (code === "RFB12") return { status: "error", message: "That player isn't in today's room." };
    throw error;
  }

  revalidatePath("/settings");
  return { status: "idle" };
}

/**
 * Undoes the caller's own most-recent Modifier Adjustment (issue #183). Only
 * ever rendered for the caller's own eligible entry (ModifierAdjustmentList),
 * so a rejection here means the window closed or another adjustment was
 * logged between render and submit — that's surfaced as a thrown error
 * rather than a friendly message, same as unassignSpellCardAction.
 */
export async function deleteModifierAdjustmentAction(formData: FormData): Promise<void> {
  const adjustmentId = formData.get("adjustmentId");
  if (typeof adjustmentId !== "string" || !adjustmentId) {
    throw new Error("deleteModifierAdjustmentAction: missing adjustmentId");
  }

  const supabase = await createClient();
  await deleteModifierAdjustment(supabase, adjustmentId);
  revalidatePath("/settings");
}
