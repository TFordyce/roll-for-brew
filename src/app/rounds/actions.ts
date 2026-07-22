"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { closeRound, declareIn, startRound } from "@/lib/supabase/rounds";
import { submitManualRoll, submitRoll } from "@/lib/supabase/rolls";
import { resolveCompletedLayerIfAny } from "@/app/rounds/layerResolution";

export async function startRoundAction() {
  const supabase = await createClient();
  await startRound(supabase);
  revalidatePath("/");
}

export async function declareInAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("declareInAction: missing roundId");
  }

  const supabase = await createClient();
  await declareIn(supabase, roundId);
  revalidatePath("/");
}

export async function closeRoundAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("closeRoundAction: missing roundId");
  }

  const supabase = await createClient();
  await closeRound(supabase, roundId);
  revalidatePath("/");
}

/** Submits the caller's in-app (server-generated) roll for the round's current layer. */
export async function submitRollAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitRollAction: missing roundId");
  }

  const supabase = await createClient();
  await submitRoll(supabase, roundId);
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidatePath("/");
}

/**
 * Submits the caller's manually-entered roll for the round's current layer
 * (#22) — the value is trusted client input, range-checked (1-20) by
 * submit_manual_roll itself.
 */
export async function submitManualRollAction(formData: FormData) {
  const roundId = formData.get("roundId");
  const rawValue = formData.get("value");
  const value = typeof rawValue === "string" ? Number(rawValue) : NaN;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitManualRollAction: missing roundId");
  }
  if (!Number.isInteger(value)) {
    throw new Error("submitManualRollAction: value must be a whole number");
  }

  const supabase = await createClient();
  await submitManualRoll(supabase, roundId, value);
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidatePath("/");
}
