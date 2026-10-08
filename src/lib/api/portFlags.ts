import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Is the C# API path on for this slice? Reads `public.port_flags`
 * (supabase/migrations/0158_port_flags.sql). A room row beats the global row (room_id null);
 * no row, or any read error, means off, so a failure always lands on the `.rpc` path.
 * Wrappers with no room (e.g. getActingAs) pass no roomId and so see only the global row.
 */
export async function isPortEnabled(supabase: SupabaseClient, slice: string, roomId?: string): Promise<boolean> {
  const { data, error } = await supabase.from("port_flags").select("room_id, enabled").eq("slice", slice);
  if (error || !data) return false;
  const rows = data as { room_id: string | null; enabled: boolean }[];
  const roomRow = roomId ? rows.find((r) => r.room_id === roomId) : undefined;
  const row = roomRow ?? rows.find((r) => r.room_id === null);
  return row?.enabled ?? false;
}
