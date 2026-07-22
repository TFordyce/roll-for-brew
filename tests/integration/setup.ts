import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const TEST_URL = process.env.SUPABASE_TEST_URL;
export const TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

export const hasTestEnv = Boolean(TEST_URL && TEST_SERVICE_ROLE_KEY);

/**
 * Service-role client against the dedicated test Supabase project. Bypasses
 * RLS, so it can seed the server-side-only whitelist table and drive the
 * Admin API the way the real GoTrue auth flow does.
 */
export function createTestAdminClient(): SupabaseClient {
  if (!hasTestEnv) {
    throw new Error(
      "SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY are not set — " +
        "integration tests should have been skipped via hasTestEnv.",
    );
  }

  return createClient(TEST_URL!, TEST_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function uniqueTestEmail(label: string) {
  return `roll-for-brew-test-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
}

export async function deleteTestUser(admin: SupabaseClient, userId: string) {
  await admin.auth.admin.deleteUser(userId);
}

export async function removeFromWhitelist(admin: SupabaseClient, email: string) {
  await admin.from("whitelist").delete().eq("email", email.toLowerCase());
}
