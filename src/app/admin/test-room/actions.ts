"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { setActingAs, endTestSession } from "@/lib/supabase/actingAs";
import { submitManualRollAs, submitRollAs } from "@/lib/supabase/rolls";
import { getRoundRoomId } from "@/lib/supabase/rounds";
import { isStaleRoundError, maybeDrawSpellCardAs, revalidateRoundSurfaces } from "@/app/rounds/roundActionHelpers";
import { advanceRound } from "@/app/rounds/advanceRound";

export async function setActingAsAction(formData: FormData): Promise<void> {
  const targetPlayerId = formData.get("targetPlayerId");
  if (typeof targetPlayerId !== "string" || !targetPlayerId) {
    throw new Error("setActingAsAction: missing targetPlayerId");
  }

  const supabase = await createClient();
  await setActingAs(supabase, targetPlayerId);
  revalidatePath("/admin/test-room");
}

export async function endTestSessionAction(): Promise<void> {
  const supabase = await createClient();
  await endTestSession(supabase);
  revalidatePath("/admin/test-room");
}

export async function submitRollAsAction(formData: FormData): Promise<void> {
  const roundId = formData.get("roundId");
  const playerId = formData.get("playerId");
  const rawForcedCardId = formData.get("forcedCardId");
  const forcedCardId = typeof rawForcedCardId === "string" && rawForcedCardId ? rawForcedCardId : undefined;
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
  await maybeDrawSpellCardAs(supabase, value, await getRoundRoomId(supabase, roundId), roundId, playerId, forcedCardId);
  await advanceRound(supabase, roundId, "layerRolled");

  revalidateRoundSurfaces();
}

export async function submitManualRollAsAction(formData: FormData): Promise<void> {
  const roundId = formData.get("roundId");
  const playerId = formData.get("playerId");
  const rawValue = formData.get("value");
  const value = typeof rawValue === "string" ? Number(rawValue) : NaN;
  const rawForcedCardId = formData.get("forcedCardId");
  const forcedCardId = typeof rawForcedCardId === "string" && rawForcedCardId ? rawForcedCardId : undefined;

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
  await maybeDrawSpellCardAs(supabase, value, await getRoundRoomId(supabase, roundId), roundId, playerId, forcedCardId);
  await advanceRound(supabase, roundId, "layerRolled");

  revalidateRoundSurfaces();
}
