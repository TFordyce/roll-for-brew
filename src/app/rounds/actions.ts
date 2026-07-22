"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  closeRound,
  declareIn,
  getRoundParticipants,
  getRoundRoomId,
  startRound,
} from "@/lib/supabase/rounds";
import {
  advanceRoundLayer,
  getCurrentLayerRollsIfComplete,
  resolveRound,
  submitManualRoll,
  submitRoll,
} from "@/lib/supabase/rolls";
import { broadcastLayerTied, broadcastRoundRevealed } from "@/lib/supabase/realtime";
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
 * was the last expected roller's roll for the round's current layer,
 * invokes the round-resolution engine (#15) over the completed layer's
 * entries. On a single-brewer outcome, persists the resolution
 * (rounds.brewer_id/cups_made/status/resolved_at plus the modifier
 * increment, all in one transaction via resolve_round) and broadcasts the
 * reveal so every connected device flips in lockstep. On a tie, persists
 * the tied subset as the next reroll layer (advance_round_layer) and
 * broadcasts that transition instead — the roster becomes a tie banner on
 * every device, with only the tied players' next roll able to move things
 * on. Recurses with no hardcoded cap: each layer that ties simply produces
 * another layer, until resolveLayer finally returns a single brewer (issue
 * #20). Shared by submitRollAction and submitManualRollAction (#22) since
 * which input method produced the just-submitted roll makes no difference
 * to how the layer resolves.
 */
async function resolveIfLayerComplete(supabase: SupabaseClient, roundId: string) {
  const completedLayer = await getCurrentLayerRollsIfComplete(supabase, roundId);
  if (!completedLayer) return;

  const { rolls } = completedLayer;
  const outcome = resolveLayer(
    rolls.map((r) => ({ playerId: r.playerId, roll: r.value, modifier: r.modifierSnapshot })),
  );

  const roomId = await getRoundRoomId(supabase, roundId);

  if (outcome.outcome === "brewer") {
    // cups_made is the number of cups the brewer owes everyone who played
    // this round — the round's original participant count, not the
    // (possibly much narrower) tied subset that rolled the final layer.
    const participants = await getRoundParticipants(supabase, roundId);
    const cupsMade = participants.length;

    await resolveRound(supabase, roundId, outcome.playerId, cupsMade);

    await broadcastRoundRevealed(supabase, roomId, {
      roundId,
      brewerId: outcome.playerId,
      cupsMade,
      rolls: rolls.map((r) => ({ playerId: r.playerId, value: r.value })),
    });
  } else {
    const nextLayer = await advanceRoundLayer(supabase, roundId, outcome.tiedPlayerIds);

    await broadcastLayerTied(supabase, roomId, {
      roundId,
      layer: nextLayer,
      tiedPlayerIds: outcome.tiedPlayerIds,
    });
  }
}

/** Submits the caller's in-app (server-generated) roll for the round's current layer. */
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
  await resolveIfLayerComplete(supabase, roundId);

  revalidatePath("/");
}
