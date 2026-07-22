import type { User } from "@supabase/supabase-js";

/**
 * Mirrors the id the on_auth_user_upsert_player trigger writes to
 * public.players.id (supabase/migrations/0001_auth_whitelist_and_players.sql):
 * the Google "sub" claim, falling back to the Supabase auth.users id.
 */
export function googlePlayerId(user: User): string {
  return (user.user_metadata.sub as string | undefined) ?? user.id;
}
