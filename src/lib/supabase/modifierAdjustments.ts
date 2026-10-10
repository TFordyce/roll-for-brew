import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor, type ApiClient } from "@/lib/api/client";
import { isPortEnabled } from "@/lib/api/portFlags";
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

export async function logModifierAdjustment(
  supabase: SupabaseClient,
  targetPlayerId: string,
  delta: number,
  reason: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<string> {
  if (await isPortEnabled(supabase, "logModifierAdjustment")) {
    return (await api().logModifierAdjustment(targetPlayerId, delta, reason)).id;
  }
  const { data, error } = await supabase.rpc("log_modifier_adjustment", {
    p_target_player_id: targetPlayerId,
    p_delta: delta,
    p_reason: reason,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteModifierAdjustment(
  supabase: SupabaseClient,
  adjustmentId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  if (await isPortEnabled(supabase, "deleteModifierAdjustment")) {
    await api().deleteModifierAdjustment(adjustmentId);
    return;
  }
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

export async function adminDeleteModifierAdjustment(
  supabase: SupabaseClient,
  adjustmentId: string,
  reason: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  if (await isPortEnabled(supabase, "adminDeleteModifierAdjustment")) {
    await api().adminDeleteModifierAdjustment(adjustmentId, reason);
    return;
  }
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
