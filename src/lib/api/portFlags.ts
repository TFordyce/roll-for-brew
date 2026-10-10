import type { SupabaseClient } from "@supabase/supabase-js";

export async function isPortEnabled(supabase: SupabaseClient, slice: string, roomId?: string): Promise<boolean> {
  const { data, error } = await supabase.from("port_flags").select("room_id, enabled").eq("slice", slice);
  if (error || !data) return false;
  const rows = data as { room_id: string | null; enabled: boolean }[];
  const roomRow = roomId ? rows.find((r) => r.room_id === roomId) : undefined;
  const row = roomRow ?? rows.find((r) => r.room_id === null);
  return row?.enabled ?? false;
}
