import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const TEST_URL = process.env.SUPABASE_TEST_URL;
export const TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
export const TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

export const hasTestEnv = Boolean(TEST_URL && TEST_SERVICE_ROLE_KEY);
export const hasAnonTestEnv = Boolean(hasTestEnv && TEST_ANON_KEY);

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

/**
 * Anon-key client against the dedicated test Supabase project. Used only to
 * sign in as a real user (not via the Admin API), which is the only way to
 * drive GoTrue's actual token-issuance path — and therefore the Custom
 * Access Token hook — the same way a real login does.
 */
export function createTestAnonClient(): SupabaseClient {
  if (!hasAnonTestEnv) {
    throw new Error(
      "SUPABASE_TEST_ANON_KEY is not set — integration tests should have " +
        "been skipped via hasAnonTestEnv.",
    );
  }

  return createClient(TEST_URL!, TEST_ANON_KEY!, {
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

/**
 * Tracks entities created during a test so they can be torn down in one
 * afterEach, instead of every test file hand-rolling the same arrays.
 */
export function createTestCleanup(admin: SupabaseClient) {
  const userIds: string[] = [];
  const whitelistedEmails: string[] = [];
  const playerIds: string[] = [];
  const roomIds: string[] = [];

  return {
    trackUser(userId: string) {
      userIds.push(userId);
    },
    trackWhitelistedEmail(email: string) {
      whitelistedEmails.push(email.toLowerCase());
    },
    /**
     * Tracks a public.players.id (the Google sub, not the auth.users id —
     * see googlePlayerId) created directly (not via trackUser's auth-user
     * path) so its row, and its room_players rows via cascade, get cleaned
     * up too.
     */
    trackPlayerId(playerId: string) {
      playerIds.push(playerId);
    },
    /**
     * Tracks a public.rooms.id created directly for a test (e.g. seeded
     * with an explicit past date), so both it and its room_players rows
     * get torn down.
     */
    trackRoom(roomId: string) {
      roomIds.push(roomId);
    },
    async run() {
      for (const roomId of roomIds.splice(0)) {
        await admin.from("room_players").delete().eq("room_id", roomId);
        await admin.from("rooms").delete().eq("id", roomId);
      }
      for (const playerId of playerIds.splice(0)) {
        await admin.from("players").delete().eq("id", playerId);
      }
      for (const id of userIds.splice(0)) {
        await admin.from("players").delete().eq("id", id);
        await deleteTestUser(admin, id);
      }
      await Promise.all(
        whitelistedEmails.splice(0).map((email) => removeFromWhitelist(admin, email)),
      );
    },
  };
}
