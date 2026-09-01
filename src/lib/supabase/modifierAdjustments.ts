import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrapJoinedPlayer } from "./playerRow";

export type ModifierAdjustment = {
  id: string;
  targetPlayerId: string;
  targetDisplayName: string | null;
  targetEmail: string;
  actorPlayerId: string;
  actorDisplayName: string | null;
  actorEmail: string;
  delta: number;
  reason: string;
  createdAt: string;
};

/**
 * Logs a signed, reasoned adjustment to a target player's modifier for
 * today's room (log_modifier_adjustment, 0052) and applies it to
 * room_players.modifier in the same transaction. The actor is derived
 * server-side from the caller's own identity inside the RPC -- never a
 * parameter here.
 */
export async function logModifierAdjustment(
  supabase: SupabaseClient,
  targetPlayerId: string,
  delta: number,
  reason: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("log_modifier_adjustment", {
    p_target_player_id: targetPlayerId,
    p_delta: delta,
    p_reason: reason,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Undoes the caller's own most-recent adjustment within its 5 minute
 * window (delete_modifier_adjustment, 0052), reversing the modifier bump.
 */
export async function deleteModifierAdjustment(supabase: SupabaseClient, adjustmentId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_modifier_adjustment", { p_adjustment_id: adjustmentId });
  if (error) throw error;
}

export type AdminModifierAdjustmentListing = {
  id: string;
  roomId: string;
  roomDate: string;
  targetDisplayName: string | null;
  targetEmail: string;
  actorDisplayName: string | null;
  actorEmail: string;
  delta: number;
  reason: string;
  createdAt: string;
};

/**
 * Recent adjustments across every room, newest first, for the
 * /admin/adjustments cleanup tool (issue #191). Same "no admin-only list RPC
 * needed" reasoning as listRecentRounds (src/lib/supabase/adminRounds.ts) --
 * modifier_adjustments is already readable by any authenticated user
 * (0052's select policy) -- only the mutation itself
 * (admin_delete_modifier_adjustment) re-checks is_admin server-side.
 */
export async function listRecentModifierAdjustments(
  supabase: SupabaseClient,
  limit = 50,
): Promise<AdminModifierAdjustmentListing[]> {
  const { data, error } = await supabase
    .from("modifier_adjustments")
    .select(
      `id, room_id, delta, reason, created_at,
       room:rooms(date),
       target:players!modifier_adjustments_target_player_id_fkey(display_name, email),
       actor:players!modifier_adjustments_actor_player_id_fkey(display_name, email)`,
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => {
    const room = unwrapJoinedPlayer(row.room as { date: string } | { date: string }[] | null);
    const target = unwrapJoinedPlayer(row.target);
    const actor = unwrapJoinedPlayer(row.actor);
    return {
      id: row.id as string,
      roomId: row.room_id as string,
      roomDate: room?.date ?? "",
      targetDisplayName: target?.display_name ?? null,
      targetEmail: target?.email ?? "",
      actorDisplayName: actor?.display_name ?? null,
      actorEmail: actor?.email ?? "",
      delta: row.delta as number,
      reason: row.reason as string,
      createdAt: row.created_at as string,
    };
  });
}

/**
 * Admin-only, unrestricted variant of deleteModifierAdjustment
 * (admin_delete_modifier_adjustment, 0056, issue #191): deletes any
 * adjustment regardless of actor/age/most-recent, reversing its modifier
 * bump the same way. Requires a reason, since deleting the row loses its
 * own reason too -- logged to admin_modifier_adjustment_deletions before
 * the row is dropped.
 */
export async function adminDeleteModifierAdjustment(
  supabase: SupabaseClient,
  adjustmentId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc("admin_delete_modifier_adjustment", {
    p_adjustment_id: adjustmentId,
    p_reason: reason,
  });
  if (error) throw error;
}

export type ModifierBreakdown = {
  cupsMade: number;
  adjustments: number;
  spellEffects: number;
};

/**
 * The three sums behind a player's room-scoped modifier (get_modifier_breakdown,
 * 0054 / 0085) — resolved-round cups_made as brewer, modifier_adjustments.delta,
 * and the rest-of-day spell modifier delta (persistent_modifier_transfer /
 * persistent_modifier_spend, issue #311) — for the modifier breakdown popover
 * (issue #184). All default to zero server-side when a player has no history of
 * that kind. cupsMade + adjustments + spellEffects reconciles to
 * room_players.modifier for every player a transfer has touched.
 */
export async function getModifierBreakdown(
  supabase: SupabaseClient,
  playerId: string,
  roomId: string,
): Promise<ModifierBreakdown> {
  const { data, error } = await supabase
    .rpc("get_modifier_breakdown", { p_player_id: playerId, p_room_id: roomId })
    .single();
  if (error) throw error;
  const row = data as { cups_made: number; adjustments: number; spell_effects: number | null };
  return {
    cupsMade: row.cups_made,
    adjustments: row.adjustments,
    spellEffects: row.spell_effects ?? 0,
  };
}

/**
 * Today's logged adjustments for a room, actor and target names included so
 * the Settings list doesn't need a second round-trip. modifier_adjustments
 * has two foreign keys into players (target_player_id, actor_player_id), so
 * each embed is disambiguated by its default constraint name
 * (<table>_<column>_fkey), the same way a self-referencing/dual-FK embed is
 * always resolved against PostgREST.
 */
export async function getTodaysModifierAdjustments(
  supabase: SupabaseClient,
  roomId: string,
): Promise<ModifierAdjustment[]> {
  const { data, error } = await supabase
    .from("modifier_adjustments")
    .select(
      `id, delta, reason, created_at, target_player_id, actor_player_id,
       target:players!modifier_adjustments_target_player_id_fkey(display_name, email),
       actor:players!modifier_adjustments_actor_player_id_fkey(display_name, email)`,
    )
    .eq("room_id", roomId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const target = unwrapJoinedPlayer(row.target);
    const actor = unwrapJoinedPlayer(row.actor);
    return {
      id: row.id as string,
      targetPlayerId: row.target_player_id as string,
      targetDisplayName: target?.display_name ?? null,
      targetEmail: target?.email ?? "",
      actorPlayerId: row.actor_player_id as string,
      actorDisplayName: actor?.display_name ?? null,
      actorEmail: actor?.email ?? "",
      delta: row.delta as number,
      reason: row.reason as string,
      createdAt: row.created_at as string,
    };
  });
}
