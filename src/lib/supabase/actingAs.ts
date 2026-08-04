import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Calls the get_acting_as RPC (supabase/migrations/0026_acting_as_and_end_test_session.sql):
 * the caller's own server-side Acting As pointer, or null if they're
 * currently acting as themselves. Only ever resolves the caller's own row —
 * there's no way to read another admin's pointer.
 */
export async function getActingAsPlayerId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_acting_as");
  if (error) throw error;
  return (data as string | null) ?? null;
}

/**
 * Calls the set_acting_as RPC: sets the caller's Acting As pointer to the
 * given player (or clears it, if targetPlayerId is the caller's own real
 * id). Admin-only server-side — a non-admin caller is rejected by the RPC
 * itself, not just hidden from the UI.
 */
export async function setActingAs(supabase: SupabaseClient, targetPlayerId: string): Promise<void> {
  const { error } = await supabase.rpc("set_acting_as", { p_target_player_id: targetPlayerId });
  if (error) throw error;
}

/**
 * Calls the end_test_session RPC: cascade-deletes the Test Room's rounds,
 * rolls, spell casts, and active effects, zeroes every Test Player's
 * accumulated room_players.modifier, resets the caller's Acting As pointer
 * back to themselves, and leaves the room and its seeded Test Player roster
 * intact.
 */
export async function endTestSession(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc("end_test_session");
  if (error) throw error;
}

/**
 * The player id the Test Room page should read and act as: the admin's
 * current Acting As pointer if one is set, otherwise the admin's own real
 * identity. Mirrors current_player_id()'s SQL resolution for the read side
 * of the page (the roster of getX() calls that take an explicit player id
 * rather than deriving it from the RPC's own security-definer chokepoint) —
 * the actual mutation-side enforcement stays entirely server-side in SQL
 * regardless of what this returns.
 */
export async function getEffectiveTestRoomPlayerId(
  supabase: SupabaseClient,
  realPlayerId: string,
): Promise<string> {
  const actingAs = await getActingAsPlayerId(supabase);
  return actingAs ?? realPlayerId;
}
