import type { SupabaseClient, User } from "@supabase/supabase-js";

export function googlePlayerId(user: User): string {
  return (user.user_metadata.sub as string | undefined) ?? user.id;
}

export async function getCurrentPlayer(
  supabase: SupabaseClient,
): Promise<{ playerId: string; user: User } | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;
  return { playerId: googlePlayerId(user), user };
}

export async function getIsAdmin(supabase: SupabaseClient, playerId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("players")
    .select("is_admin")
    .eq("id", playerId)
    .maybeSingle();

  if (error) throw error;
  return data?.is_admin === true;
}

export type RealPlayer = { id: string; displayName: string | null; email: string };

export async function getRealPlayers(supabase: SupabaseClient): Promise<RealPlayer[]> {
  const { data, error } = await supabase
    .from("players")
    .select("id, display_name, email")
    .eq("is_test", false)
    .order("display_name")
    .order("email");

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id as string,
    displayName: row.display_name as string | null,
    email: row.email as string,
  }));
}
