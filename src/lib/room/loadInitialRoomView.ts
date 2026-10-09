import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor } from "@/lib/api/client";
import { isPortEnabled } from "@/lib/api/portFlags";
import type { RoomView } from "./roomViewStore";

/** The port flag (public.port_flags) that renders a room from the room view instead of per-panel reads. */
export const ROOM_VIEW_FLAG = "room_view";

/**
 * Server components: the room's view when `room_view` is on for it, else null (render the legacy
 * page). Calls the API server-to-server with the user's session JWT. If the flagged call fails
 * (API down, unset URL) the page falls back to the legacy render rather than erroring, so a bad
 * API deploy cannot take the room down.
 */
export async function loadInitialRoomView(supabase: SupabaseClient, roomId: string): Promise<RoomView | null> {
  if (!(await isPortEnabled(supabase, ROOM_VIEW_FLAG, roomId))) return null;
  try {
    return await apiClientFor(supabase).getRoomView(roomId);
  } catch (error) {
    console.error("room_view is on but the view could not be loaded; rendering the legacy page", error);
    return null;
  }
}
