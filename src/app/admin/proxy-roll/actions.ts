"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { adminProxyRoll } from "@/lib/supabase/rolls";
import { resolveCompletedLayerIfAny } from "@/app/rounds/layerResolution";
import { isStaleRoundError } from "@/app/rounds/roundActionHelpers";

export type AdminProxyRollState = { status: "idle" } | { status: "error"; message: string };

/**
 * Submits a Proxy Roll (issue #273): an admin entering a value on a
 * physically-present-but-not-logged-in player's behalf, folding them into
 * the live round as a full participant. admin_proxy_roll
 * (0071_admin_proxy_roll.sql) does the fold-in (implicit room_players row +
 * round_participants row) and inserts the roll itself; from here it's the
 * same "did that complete the layer" follow-up submitManualRollAction takes
 * (src/app/rounds/actions.ts) — opening the reaction window or resolving
 * the round if this was the last outstanding roll.
 */
export async function adminProxyRollAction(
  _prevState: AdminProxyRollState,
  formData: FormData,
): Promise<AdminProxyRollState> {
  const roundId = formData.get("roundId");
  const playerId = formData.get("playerId");
  const rawValue = formData.get("value");
  const value = typeof rawValue === "string" ? Number(rawValue) : NaN;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("adminProxyRollAction: missing roundId");
  }
  if (typeof playerId !== "string" || !playerId) {
    return { status: "error", message: "Choose which player this roll is for." };
  }
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    return { status: "error", message: "Enter the value they rolled, 1-20." };
  }

  const supabase = await createClient();
  try {
    await adminProxyRoll(supabase, roundId, playerId, value);
  } catch (error) {
    if (isStaleRoundError(error)) {
      revalidatePath("/admin/proxy-roll");
      return { status: "idle" };
    }
    // Same "strip the RPC's own function_name: prefix, capitalize, period"
    // handling deleteRoundAction (src/app/admin/rounds/actions.ts) and
    // allocateSpellCardAction (src/app/admin/cards/actions.ts) already
    // model for this admin-tool family — admin_proxy_roll has no dedicated
    // error codes of its own beyond RFB32 (handled above), so everything
    // left over is a plain precondition failure, not a race.
    const rawMessage = (error as { message?: string } | null)?.message?.replace(/^[a-z_]+:\s*/, "");
    return {
      status: "error",
      message: rawMessage ? rawMessage.charAt(0).toUpperCase() + rawMessage.slice(1) + "." : "Could not submit that roll.",
    };
  }

  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidatePath("/admin/proxy-roll");
  revalidatePath("/");
  return { status: "idle" };
}
