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

/**
 * Calls the admin_get_card_assignments RPC (supabase/migrations/
 * 0047_admin_allocate_spell_cards.sql): every catalog card plus its current
 * physical-instance state and holder, for the /admin/cards bulk table
 * (issue #154). Admin-only — the RPC re-checks is_admin regardless of what
 * called it.
 */
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

/**
 * Calls the admin_allocate_spell_card RPC: assigns a catalog card to a
 * player as "held" and records the spell_draws row (trigger =
 * 'admin_allocation') needed for the Spell Collection page to count it as
 * discovered. Throws with error.code "RFB07" if the card is already held by
 * someone else, or "RFB08" if the target player already holds a different
 * card — callers should surface both as a retryable message naming the
 * conflict, not a crash.
 */
export async function allocateSpellCard(
  supabase: SupabaseClient,
  cardId: string,
  playerId: string,
): Promise<void> {
  const { error } = await supabase.rpc("admin_allocate_spell_card", {
    p_card_id: cardId,
    p_player_id: playerId,
  });
  if (error) throw error;
}

/**
 * Calls the admin_unassign_spell_card RPC: returns a held/pending-swap
 * card's instance to in_deck, the "explicit unassign first" step the
 * conflict handling above requires. Doesn't touch spell_draws history.
 */
export async function unassignSpellCard(supabase: SupabaseClient, cardId: string): Promise<void> {
  const { error } = await supabase.rpc("admin_unassign_spell_card", { p_card_id: cardId });
  if (error) throw error;
}
