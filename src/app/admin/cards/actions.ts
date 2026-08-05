"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { allocateSpellCard, unassignSpellCard } from "@/lib/supabase/adminCards";

export type AllocateSpellCardState = { status: "idle" } | { status: "error"; message: string };

/**
 * Assigns a catalog card to a player, per issue #154's admin allocation
 * tool. Keyed off the RFB07/RFB08 error codes admin_allocate_spell_card
 * raises (0047_admin_allocate_spell_cards.sql) — the same "block, don't
 * auto-reassign" conflict handling drawPendingSpellCardManualAction already
 * models for RFB06 (src/app/rounds/actions.ts) — so both conflicts surface
 * as a friendly, retryable message instead of a crash.
 */
export async function allocateSpellCardAction(
  _prevState: AllocateSpellCardState,
  formData: FormData,
): Promise<AllocateSpellCardState> {
  const cardId = formData.get("cardId");
  const playerId = formData.get("playerId");

  if (typeof cardId !== "string" || !cardId) {
    throw new Error("allocateSpellCardAction: missing cardId");
  }
  if (typeof playerId !== "string" || !playerId) {
    return { status: "error", message: "Pick a player first." };
  }

  const supabase = await createClient();
  try {
    await allocateSpellCard(supabase, cardId, playerId);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "RFB07" || code === "RFB08") {
      const rawMessage = (error as { message?: string } | null)?.message ?? "";
      // The RPC's own raise-exception text (0047) is already the
      // user-facing message, prefixed with "admin_allocate_spell_card: " —
      // strip that prefix rather than hand-writing a second copy of it here.
      const message = rawMessage.replace(/^admin_allocate_spell_card:\s*/, "");
      return {
        status: "error",
        message: message ? message.charAt(0).toUpperCase() + message.slice(1) + "." : "That assignment conflicts with an existing hold.",
      };
    }
    throw error;
  }

  revalidatePath("/admin/cards");
  return { status: "idle" };
}

/**
 * Returns a held/pending-swap card to in_deck — the "unassign first" half
 * of the conflict handling above.
 */
export async function unassignSpellCardAction(formData: FormData): Promise<void> {
  const cardId = formData.get("cardId");
  if (typeof cardId !== "string" || !cardId) {
    throw new Error("unassignSpellCardAction: missing cardId");
  }

  const supabase = await createClient();
  await unassignSpellCard(supabase, cardId);
  revalidatePath("/admin/cards");
}
