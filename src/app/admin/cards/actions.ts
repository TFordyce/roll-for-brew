"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { allocateSpellCard, unassignSpellCard, type MarkChoice } from "@/lib/supabase/adminCards";

export type AllocateSpellCardState =
  | { status: "idle" }
  | { status: "error"; message: string }
  // The target has a live Stale Biscuit mark (RFB57, issue #471): the row
  // asks the admin to allocate anyway, cancel, or give it to the beneficiary.
  | { status: "mark_warning"; playerId: string; beneficiaryId: string; message: string }
  // Allocated, but worth saying how: the beneficiary option fizzled.
  | { status: "notice"; message: string };

/**
 * The RPC's own raise-exception text (0047 / admin_allocate_spell_card.sql) is already the
 * user-facing message, prefixed with "admin_allocate_spell_card: " — strip
 * that prefix rather than hand-writing a second copy of it here.
 */
function rpcMessage(error: unknown): string {
  const rawMessage = (error as { message?: string } | null)?.message ?? "";
  const message = rawMessage.replace(/^admin_allocate_spell_card:\s*/, "");
  return message ? message.charAt(0).toUpperCase() + message.slice(1) + "." : "";
}

/**
 * Assigns a catalog card to a player, per issue #154's admin allocation
 * tool. Keyed off the RFB07/RFB08 error codes admin_allocate_spell_card
 * raises (0047_admin_allocate_spell_cards.sql) — the same "block, don't
 * auto-reassign" conflict handling drawPendingSpellCardManualAction already
 * models for RFB06 (src/app/rounds/actions.ts) — so both conflicts surface
 * as a friendly, retryable message instead of a crash.
 *
 * RFB57 (issue #471) is the same shape for a live Stale Biscuit mark on the
 * target: the action returns a mark_warning, and the row re-submits with a
 * `markChoice` of "target" or "beneficiary", or "cancel", which allocates
 * nothing.
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

  const markChoiceField = formData.get("markChoice");
  if (markChoiceField === "cancel") {
    return { status: "idle" };
  }
  const markChoice: MarkChoice | undefined =
    markChoiceField === "target" || markChoiceField === "beneficiary" ? markChoiceField : undefined;

  const supabase = await createClient();
  let result;
  try {
    result = await allocateSpellCard(supabase, cardId, playerId, markChoice);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    // RFB58: "beneficiary" was chosen but the mark was spent since the warning.
    if (code === "RFB07" || code === "RFB08" || code === "RFB58") {
      return { status: "error", message: rpcMessage(error) || "That assignment conflicts with an existing hold." };
    }
    if (code === "RFB57") {
      return {
        status: "mark_warning",
        playerId,
        beneficiaryId: (error as { details?: string }).details ?? "",
        message: rpcMessage(error) || "That player has a live Stale Biscuit mark.",
      };
    }
    throw error;
  }

  revalidatePath("/admin/cards");
  if (result.drawRedirectOutcome === "fizzled") {
    return {
      status: "notice",
      message: "The marker's hand was full, so the Stale Biscuit fizzled: the card went to the target and the mark is spent.",
    };
  }
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
