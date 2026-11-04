"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { adminBackfillRound, backfillFailureMessage, type BackfillLayer } from "@/lib/supabase/adminBackfill";

export type BackfillRoundState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; roundId: string };

export async function backfillRoundAction(
  _prevState: BackfillRoundState,
  formData: FormData,
): Promise<BackfillRoundState> {
  const participantIdsRaw = formData.get("participantIds");
  const layersRaw = formData.get("layers");

  if (typeof participantIdsRaw !== "string" || typeof layersRaw !== "string") {
    throw new Error("backfillRoundAction: missing payload");
  }

  let participantIds: string[];
  let layers: BackfillLayer[];
  try {
    participantIds = JSON.parse(participantIdsRaw);
    layers = JSON.parse(layersRaw);
  } catch {
    throw new Error("backfillRoundAction: malformed payload");
  }

  const supabase = await createClient();
  try {
    const roundId = await adminBackfillRound(supabase, participantIds, layers);
    revalidatePath("/admin/backfill");
    revalidatePath("/stats");
    return { status: "success", roundId };
  } catch (error) {
    const message = backfillFailureMessage(error);
    if (message) return { status: "error", message };
    throw error;
  }
}
