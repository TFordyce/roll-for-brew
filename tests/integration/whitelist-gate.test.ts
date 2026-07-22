import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestAnonClient,
  createTestCleanup,
  hasAnonTestEnv,
  hasTestEnv,
  uniqueTestEmail,
} from "./setup";

// Runs against a real, dedicated test Supabase project (see .env.example).
// Exercises the actual auth hooks
// (supabase/migrations/0001_auth_whitelist_and_players.sql,
// 0002_enforce_whitelist_on_every_login.sql) through the same GoTrue
// user-creation/token-issuance paths a real OAuth sign-in goes through,
// rather than calling the SQL functions directly — their execute grants are
// deliberately restricted to supabase_auth_admin, so they can only be
// exercised end-to-end, which is also the more faithful test.
describe.skipIf(!hasTestEnv)("whitelist gate (auth hooks)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  // Uses the anon client's self-serve signUp rather than the Admin API: the
  // Admin API (admin.createUser) is a privileged bypass in GoTrue that never
  // invokes the "before user created" hook, so it would always succeed
  // regardless of the whitelist. signUp goes through the real GoTrue signup
  // path, which does call the hook — the same path an OAuth sign-in takes.
  it.skipIf(!hasAnonTestEnv)(
    "rejects a non-whitelisted identity outright — no user, no session",
    async () => {
      const email = uniqueTestEmail("rejected");
      const password = `Test-password-${Math.random().toString(36).slice(2)}!`;

      const anon = createTestAnonClient();
      const { data, error } = await anon.auth.signUp({ email, password });

      expect(error).not.toBeNull();
      expect(data.user).toBeNull();
      expect(data.session).toBeNull();

      const { data: lookup } = await admin.auth.admin.listUsers();
      expect(lookup.users.some((u) => u.email === email)).toBe(false);
    },
  );

  it("accepts a whitelisted identity and reaches a created user", async () => {
    const email = uniqueTestEmail("accepted");
    cleanup.trackWhitelistedEmail(email);

    const { error: seedError } = await admin
      .from("whitelist")
      .insert({ email: email.toLowerCase() });
    expect(seedError).toBeNull();

    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { sub: "fake-google-sub-accepted", name: "Accepted Person" },
    });

    expect(error).toBeNull();
    expect(data.user).not.toBeNull();
    if (data.user) cleanup.trackUser(data.user.id);
    expect(data.user?.email).toBe(email);
  });

  it("whitelist matching is case-insensitive on email", async () => {
    const email = uniqueTestEmail("MixedCase");
    cleanup.trackWhitelistedEmail(email);

    await admin.from("whitelist").insert({ email: email.toLowerCase() });

    const { data, error } = await admin.auth.admin.createUser({
      email: email.toUpperCase(),
      email_confirm: true,
      user_metadata: { sub: "fake-google-sub-mixed-case" },
    });

    expect(error).toBeNull();
    expect(data.user).not.toBeNull();
    if (data.user) cleanup.trackUser(data.user.id);
  });

  describe.skipIf(!hasAnonTestEnv)("revocation on later login", () => {
    it("locks out an identity removed from the whitelist after its account was created", async () => {
      const email = uniqueTestEmail("revoked");
      const password = `Test-password-${Math.random().toString(36).slice(2)}!`;
      cleanup.trackWhitelistedEmail(email);

      await admin.from("whitelist").insert({ email: email.toLowerCase() });
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { sub: `fake-google-sub-revoked-${Date.now()}` },
      });
      expect(createError).toBeNull();
      if (created.user) cleanup.trackUser(created.user.id);

      // First login succeeds — still whitelisted, and this exercises the
      // real token-issuance path the Custom Access Token hook runs on.
      const firstLogin = createTestAnonClient();
      const { data: firstSession, error: firstError } =
        await firstLogin.auth.signInWithPassword({ email, password });
      expect(firstError).toBeNull();
      expect(firstSession.session).not.toBeNull();

      // Remove from the whitelist without touching the account itself.
      await admin.from("whitelist").delete().eq("email", email.toLowerCase());

      // A later login attempt must now be rejected outright.
      const secondLogin = createTestAnonClient();
      const { data: secondSession, error: secondError } =
        await secondLogin.auth.signInWithPassword({ email, password });

      expect(secondError).not.toBeNull();
      expect(secondSession.session).toBeNull();
    });
  });
});
