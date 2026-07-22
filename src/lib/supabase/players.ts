import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Mirrors the id the on_auth_user_upsert_player trigger writes to
 * public.players.id (supabase/migrations/0001_auth_whitelist_and_players.sql):
 * the Google "sub" claim, falling back to the Supabase auth.users id.
 */
export function googlePlayerId(user: User): string {
  return (user.user_metadata.sub as string | undefined) ?? user.id;
}

/**
 * The signed-in caller's identity, or null if there isn't one — the common
 * "who is this request from" lookup shared by every page and server action
 * that needs it, instead of each repeating supabase.auth.getUser() +
 * googlePlayerId(). Callers decide how to react to a null (redirect for a
 * page, throw for a server action).
 */
export async function getCurrentPlayer(
  supabase: SupabaseClient,
): Promise<{ playerId: string; user: User } | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;
  return { playerId: googlePlayerId(user), user };
}
