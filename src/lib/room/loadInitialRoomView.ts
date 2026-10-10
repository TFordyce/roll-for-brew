import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor } from "@/lib/api/client";
import { isPortEnabled } from "@/lib/api/portFlags";
import type { RoomView } from "./roomViewStore";

export const ROOM_VIEW_FLAG = "room_view";

export async function loadInitialRoomView(supabase: SupabaseClient, roomId: string): Promise<RoomView | null> {
  if (!(await isPortEnabled(supabase, ROOM_VIEW_FLAG, roomId))) return null;
  try {
    return await apiClientFor(supabase).getRoomView(roomId);
  } catch (error) {
    console.error("room_view is on but the view could not be loaded; rendering the legacy page", error);
    return null;
  }
}
