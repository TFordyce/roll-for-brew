"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { ROLL_INPUT_MODES, setRollInputMode, type RollInputMode } from "@/lib/supabase/playerSettings";
import { setAdminModeEnabled } from "@/lib/supabase/adminMode";
import { deleteModifierAdjustment, logModifierAdjustment } from "@/lib/supabase/modifierAdjustments";
import {
  DRINK_TYPES,
  MILK_OPTIONS,
  SUGAR_OPTIONS,
  setUsualDrink,
  type DrinkType,
  type Milk,
  type Sugar,
} from "@/lib/supabase/usualDrinks";

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

export type UpdateUsualDrinkState = { status: "idle" } | { status: "saved"; drinkType: DrinkType };

export async function updateUsualDrinkAction(
  _prevState: UpdateUsualDrinkState,
  formData: FormData,
): Promise<UpdateUsualDrinkState> {
  const drinkType = formData.get("drinkType");
  const milk = formData.get("milk");
  const sugar = formData.get("sugar");
  const decaf = formData.get("decaf") !== null;

  if (typeof drinkType !== "string" || !DRINK_TYPES.includes(drinkType as DrinkType)) {
    throw new Error("updateUsualDrinkAction: invalid drinkType");
  }
  if (typeof milk !== "string" || !MILK_OPTIONS.includes(milk as Milk)) {
    throw new Error("updateUsualDrinkAction: invalid milk");
  }
  if (typeof sugar !== "string" || !SUGAR_OPTIONS.includes(sugar as Sugar)) {
    throw new Error("updateUsualDrinkAction: invalid sugar");
  }

  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);
  if (!current) {
    throw new Error("updateUsualDrinkAction: not authenticated");
  }

  await setUsualDrink(supabase, current.playerId, drinkType as DrinkType, milk as Milk, sugar as Sugar, decaf);
  revalidatePath("/settings");
  return { status: "saved", drinkType: drinkType as DrinkType };
}

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

export async function deleteModifierAdjustmentAction(formData: FormData): Promise<void> {
  const adjustmentId = formData.get("adjustmentId");
  if (typeof adjustmentId !== "string" || !adjustmentId) {
    throw new Error("deleteModifierAdjustmentAction: missing adjustmentId");
  }

  const supabase = await createClient();
  await deleteModifierAdjustment(supabase, adjustmentId);
  revalidatePath("/settings");
}
