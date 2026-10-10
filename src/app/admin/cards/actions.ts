"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { allocateSpellCard, unassignSpellCard, type MarkChoice } from "@/lib/supabase/adminCards";

export type AllocateSpellCardState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "mark_warning"; playerId: string; beneficiaryId: string; message: string }
  | { status: "notice"; message: string };

function rpcMessage(error: unknown): string {
  const rawMessage = (error as { message?: string } | null)?.message ?? "";
  const message = rawMessage.replace(/^admin_allocate_spell_card:\s*/, "");
  return message ? message.charAt(0).toUpperCase() + message.slice(1) + "." : "";
}

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

export async function unassignSpellCardAction(formData: FormData): Promise<void> {
  const cardId = formData.get("cardId");
  if (typeof cardId !== "string" || !cardId) {
    throw new Error("unassignSpellCardAction: missing cardId");
  }

  const supabase = await createClient();
  await unassignSpellCard(supabase, cardId);
  revalidatePath("/admin/cards");
}
