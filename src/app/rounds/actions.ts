"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { closeRound, declareIn, getRoundRoomId, startRound } from "@/lib/supabase/rounds";
import {
  getLayerZeroRollsIfComplete,
  resolveRound,
  submitManualRoll,
  submitRoll,
} from "@/lib/supabase/rolls";
import { broadcastRoundRevealed } from "@/lib/supabase/realtime";
import { resolveLayer } from "@/lib/game/resolveLayer";

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

/**
 * Shared tail end of both submit-roll actions: if the just-submitted roll
 * was the last declared participant's, invokes the round-resolution engine
 * (#15) over the completed layer-0 entries. On a single-brewer outcome,
 * persists the resolution (rounds.brewer_id/cups_made/status/resolved_at
 * plus the modifier increment, all in one transaction via resolve_round) and
 * broadcasts the reveal so every connected device flips in lockstep. A tie
 * outcome is left for a later ticket — declarations stay 'closed' with no
 * further action here.
 */
async function resolveIfLayerComplete(supabase: SupabaseClient, roundId: string) {
  const rolls = await getLayerZeroRollsIfComplete(supabase, roundId);
  if (rolls.length === 0) return;

  const outcome = resolveLayer(
    rolls.map((r) => ({ playerId: r.playerId, roll: r.value, modifier: r.modifierSnapshot })),
  );

  if (outcome.outcome !== "brewer") return;

  await resolveRound(supabase, roundId, outcome.playerId, rolls.length);

  const roomId = await getRoundRoomId(supabase, roundId);

  await broadcastRoundRevealed(supabase, roomId, {
    roundId,
    brewerId: outcome.playerId,
    cupsMade: rolls.length,
    rolls: rolls.map((r) => ({ playerId: r.playerId, value: r.value })),
  });
}

/** Submits the caller's in-app (server-generated) roll for a closed round. */
export async function submitRollAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitRollAction: missing roundId");
  }

  const supabase = await createClient();
  await submitRoll(supabase, roundId);
  await resolveIfLayerComplete(supabase, roundId);

  revalidatePath("/");
}

/**
 * Submits the caller's manually-entered roll for a closed round (#22) — the
 * value is trusted client input, range-checked (1-20) by submit_manual_roll
 * itself.
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
  await resolveIfLayerComplete(supabase, roundId);

  revalidatePath("/");
}
