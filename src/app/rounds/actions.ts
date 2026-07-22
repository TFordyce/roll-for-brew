"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { closeRound, declareIn, getRoundRoomId, startRound } from "@/lib/supabase/rounds";
import { submitManualRoll, submitRoll } from "@/lib/supabase/rolls";
import { resolveCompletedLayerIfAny } from "@/app/rounds/layerResolution";
import { broadcastRoundClosed } from "@/lib/supabase/realtime";

/**
 * True for the two submit_roll/submit_manual_roll rejections that mean "the
 * round moved on under you" rather than a real failure — the stall-timeout
 * checker (enforceStallTimeout, src/app/rounds/stallEnforcement.ts) runs
 * lazily on every render, so it can cancel a round or exclude this player
 * from the current layer between the page rendering the roll form and the
 * form actually being submitted. Surfacing that race as a crash (the prior
 * behaviour: throw straight through, no error boundary anywhere in
 * src/app) sent the stalled player to a raw error page for a state change
 * that was correct and expected; refreshing to the room's current state is
 * the right response instead.
 */
function isStaleRoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    message.endsWith("round is not closed for rolling") ||
    message.endsWith("caller is not expected to roll in the current layer")
  );
}

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

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoundClosed(supabase, roomId, { roundId });

  revalidatePath("/");
}

/** Submits the caller's in-app (server-generated) roll for the round's current layer. */
export async function submitRollAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitRollAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await submitRoll(supabase, roundId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }
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
  try {
    await submitManualRoll(supabase, roundId, value);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidatePath("/");
}
