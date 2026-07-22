import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseEnv } from "./cookies";

export function createClient() {
  const { url, anonKey } = requireSupabaseEnv();
  return createBrowserClient(url, anonKey);
}
