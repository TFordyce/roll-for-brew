import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor } from "@/lib/api/client";
import { enterTodaysRoom } from "@/lib/supabase/rooms";
import type { RoomView } from "./roomViewStore";

export async function loadInitialRoomView(supabase: SupabaseClient, roomId: string): Promise<RoomView> {
  return apiClientFor(supabase).getRoomView(roomId);
}

export async function enterTodaysRoomAndLoadView(
  supabase: SupabaseClient,
): Promise<{ roomId: string; initialView: RoomView }> {
  const roomId = await enterTodaysRoom(supabase);
  return { roomId, initialView: await loadInitialRoomView(supabase, roomId) };
}
