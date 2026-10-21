import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor } from "@/lib/api/client";
import type { RoomView } from "./roomViewStore";

export async function loadInitialRoomView(supabase: SupabaseClient, roomId: string): Promise<RoomView> {
  return apiClientFor(supabase).getRoomView(roomId);
}
