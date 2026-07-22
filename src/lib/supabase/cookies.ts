import type { CookieOptions } from "@supabase/ssr";

export type CookieToSet = { name: string; value: string; options: CookieOptions };

export function requireSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.",
    );
  }

  return { url, anonKey };
}
