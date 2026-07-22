"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { closeRound, declareIn, getRoundRoomId, startRound } from "@/lib/supabase/rounds";
import { getLayerZeroRollsIfComplete, resolveRound, submitRoll } from "@/lib/supabase/rolls";
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
 * Submits the caller's roll for a closed round and, if that was the last
 * declared participant's roll, invokes the round-resolution engine (#15)
 * over the completed layer-0 entries. On a single-brewer outcome, persists
 * the resolution (rounds.brewer_id/cups_made/status/resolved_at plus the
 * modifier increment, all in one transaction via resolve_round) and
 * broadcasts the reveal so every connected device flips in lockstep. A tie
 * outcome is left for a later ticket — declarations stay 'closed' with no
 * further action here.
 */
export async function submitRollAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitRollAction: missing roundId");
  }

  const supabase = await createClient();
  await submitRoll(supabase, roundId);

  const rolls = await getLayerZeroRollsIfComplete(supabase, roundId);
  if (rolls.length > 0) {
    const outcome = resolveLayer(
      rolls.map((r) => ({ playerId: r.playerId, roll: r.value, modifier: r.modifierSnapshot })),
    );

    if (outcome.outcome === "brewer") {
      await resolveRound(supabase, roundId, outcome.playerId, rolls.length);

      const roomId = await getRoundRoomId(supabase, roundId);

      await broadcastRoundRevealed(supabase, roomId, {
        roundId,
        brewerId: outcome.playerId,
        cupsMade: rolls.length,
        rolls: rolls.map((r) => ({ playerId: r.playerId, value: r.value })),
      });
    }
  }

  revalidatePath("/");
}
