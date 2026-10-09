import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor, type ApiClient } from "@/lib/api/client";
import { isPortEnabled } from "@/lib/api/portFlags";

export async function getActingAsPlayerId(
  supabase: SupabaseClient,
  api: () => Pick<ApiClient, "getActingAs"> = () => apiClientFor(supabase),
): Promise<string | null> {
  if (await isPortEnabled(supabase, "getActingAs")) {
    return (await api().getActingAs()).actingAsPlayerId ?? null;
  }
  const { data, error } = await supabase.rpc("get_acting_as");
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function setActingAs(supabase: SupabaseClient, targetPlayerId: string): Promise<void> {
  const { error } = await supabase.rpc("set_acting_as", { p_target_player_id: targetPlayerId });
  if (error) throw error;
}

export async function endTestSession(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc("end_test_session");
  if (error) throw error;
}

export async function getEffectiveTestRoomPlayerId(
  supabase: SupabaseClient,
  realPlayerId: string,
): Promise<string> {
  const actingAs = await getActingAsPlayerId(supabase);
  return actingAs ?? realPlayerId;
}
