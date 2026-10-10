import type { SupabaseClient } from "@supabase/supabase-js";

export type CardAssignment = {
  cardId: string;
  name: string;
  tier: "common" | "rare" | "epic";
  instanceId: string;
  location: "in_deck" | "held" | "pending_swap";
  heldByPlayerId: string | null;
  heldByDisplayName: string | null;
  heldByEmail: string | null;
};

export async function getCardAssignments(supabase: SupabaseClient): Promise<CardAssignment[]> {
  const { data, error } = await supabase.rpc("admin_get_card_assignments");
  if (error) throw error;

  return ((data ?? []) as {
    card_id: string;
    name: string;
    tier: "common" | "rare" | "epic";
    instance_id: string;
    location: "in_deck" | "held" | "pending_swap";
    held_by_player: string | null;
    held_by_display_name: string | null;
    held_by_email: string | null;
  }[]).map((row) => ({
    cardId: row.card_id,
    name: row.name,
    tier: row.tier,
    instanceId: row.instance_id,
    location: row.location,
    heldByPlayerId: row.held_by_player,
    heldByDisplayName: row.held_by_display_name,
    heldByEmail: row.held_by_email,
  }));
}

export type MarkChoice = "target" | "beneficiary";

export type DrawRedirectOutcome = "redirected" | "fizzled";

export type AllocationResult = {
  recipientPlayerId: string;
  drawRedirectOutcome: DrawRedirectOutcome | null;
};

export async function allocateSpellCard(
  supabase: SupabaseClient,
  cardId: string,
  playerId: string,
  markChoice?: MarkChoice,
): Promise<AllocationResult> {
  const { data, error } = await supabase.rpc("admin_allocate_spell_card", {
    p_card_id: cardId,
    p_player_id: playerId,
    p_mark_choice: markChoice ?? null,
  });
  if (error) throw error;

  const [row] = (data ?? []) as { recipient_player_id: string; draw_redirect_outcome: DrawRedirectOutcome | null }[];
  return { recipientPlayerId: row!.recipient_player_id, drawRedirectOutcome: row!.draw_redirect_outcome };
}

export async function unassignSpellCard(supabase: SupabaseClient, cardId: string): Promise<void> {
  const { error } = await supabase.rpc("admin_unassign_spell_card", { p_card_id: cardId });
  if (error) throw error;
}
