"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { setActingAs, endTestSession } from "@/lib/supabase/actingAs";
import { submitManualRollAs, submitRollAs } from "@/lib/supabase/rolls";
import { getRoundRoomId } from "@/lib/supabase/rounds";
import { isStaleRoundError, maybeDrawSpellCard, revalidateRoundSurfaces } from "@/app/rounds/roundActionHelpers";
import { resolveCompletedLayerIfAny } from "@/app/rounds/layerResolution";

/**
 * Switches which seeded Test Player (or the admin's own real identity) the
 * caller is currently Acting As (issue #102). set_acting_as itself re-checks
 * is_admin server-side, so posting directly to this action as a non-admin
 * is rejected by the RPC rather than trusted from the form.
 */
export async function setActingAsAction(formData: FormData): Promise<void> {
  const targetPlayerId = formData.get("targetPlayerId");
  if (typeof targetPlayerId !== "string" || !targetPlayerId) {
    throw new Error("setActingAsAction: missing targetPlayerId");
  }

  const supabase = await createClient();
  await setActingAs(supabase, targetPlayerId);
  revalidatePath("/admin/test-room");
}

/**
 * Clears the Test Room's accumulated rounds/rolls/casts/effects, leaving the
 * room and its seeded roster ready for next time (issue #102).
 */
export async function endTestSessionAction(): Promise<void> {
  const supabase = await createClient();
  await endTestSession(supabase);
  revalidatePath("/admin/test-room");
}

/**
 * Rolls in-app on behalf of another Test Room player (issue #102 follow-up:
 * "roll for others") — lets the admin fill a pending roll without switching
 * Acting As to become that player first. submit_roll_as re-checks is_admin
 * and Test Room membership server-side regardless of what this form posts.
 */
export async function submitRollAsAction(formData: FormData): Promise<void> {
  const roundId = formData.get("roundId");
  const playerId = formData.get("playerId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitRollAsAction: missing roundId");
  }
  if (typeof playerId !== "string" || !playerId) {
    throw new Error("submitRollAsAction: missing playerId");
  }

  const supabase = await createClient();
  let value: number;
  try {
    value = await submitRollAs(supabase, roundId, playerId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidateRoundSurfaces();
    return;
  }
  await maybeDrawSpellCard(supabase, value, await getRoundRoomId(supabase, roundId));
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidateRoundSurfaces();
}

/**
 * Submits a manually-entered value on behalf of another Test Room player —
 * the "enter dice rolls for each person" counterpart to submitRollAsAction.
 */
export async function submitManualRollAsAction(formData: FormData): Promise<void> {
  const roundId = formData.get("roundId");
  const playerId = formData.get("playerId");
  const rawValue = formData.get("value");
  const value = typeof rawValue === "string" ? Number(rawValue) : NaN;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitManualRollAsAction: missing roundId");
  }
  if (typeof playerId !== "string" || !playerId) {
    throw new Error("submitManualRollAsAction: missing playerId");
  }
  if (!Number.isInteger(value)) {
    throw new Error("submitManualRollAsAction: value must be a whole number");
  }

  const supabase = await createClient();
  try {
    await submitManualRollAs(supabase, roundId, playerId, value);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidateRoundSurfaces();
    return;
  }
  await maybeDrawSpellCard(supabase, value, await getRoundRoomId(supabase, roundId));
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidateRoundSurfaces();
}
