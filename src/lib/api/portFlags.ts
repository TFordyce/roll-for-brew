import type { SupabaseClient } from "@supabase/supabase-js";

export type PortFlagRow = { room_id: string | null; enabled: boolean };

/** The slice's rows in one small select — the flag decision's only mandatory read. */
export async function portFlagRows(supabase: SupabaseClient, slice: string): Promise<PortFlagRow[]> {
  const { data, error } = await supabase.from("port_flags").select("room_id, enabled").eq("slice", slice);
  return error || !data ? [] : (data as PortFlagRow[]);
}

/** A room-scoped row decides for its room; otherwise the global row; otherwise off. */
export function portFlagDecides(rows: PortFlagRow[], roomId?: string): boolean {
  const roomRow = roomId ? rows.find((r) => r.room_id === roomId) : undefined;
  const row = roomRow ?? rows.find((r) => r.room_id === null);
  return row?.enabled ?? false;
}

export async function isPortEnabled(supabase: SupabaseClient, slice: string, roomId?: string): Promise<boolean> {
  return portFlagDecides(await portFlagRows(supabase, slice), roomId);
}
