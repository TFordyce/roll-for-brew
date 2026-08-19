"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { adminBackfillRound, type BackfillLayer } from "@/lib/supabase/adminBackfill";

export type BackfillRoundState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; roundId: string };

const KNOWN_ERROR_CODES = new Set(["RFB32", "RFB33", "RFB34", "RFB35", "RFB36", "RFB37", "RFB38", "RFB39"]);

/**
 * Submits a fully-built Round Backfill payload (issue #274) — the wizard in
 * BackfillRoundForm.tsx has already walked the admin through every layer
 * client-side via resolveLayer.ts, so by the time this fires,
 * `participantIds`/`layers` are the complete, resolved round. Keyed off the
 * RFB32–RFB39 codes admin_backfill_round raises (0071), same "strip the
 * RPC's own prefix, surface the rest" handling deleteRoundAction
 * (src/app/admin/rounds/actions.ts) already models.
 */
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
    const code = (error as { code?: string } | null)?.code;
    if (code && KNOWN_ERROR_CODES.has(code)) {
      const rawMessage = (error as { message?: string } | null)?.message ?? "";
      const message = rawMessage.replace(/^admin_backfill_round:\s*/, "");
      return {
        status: "error",
        message: message ? message.charAt(0).toUpperCase() + message.slice(1) + "." : "Could not backfill that round.",
      };
    }
    throw error;
  }
}
