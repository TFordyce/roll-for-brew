import { afterEach, describe, expect, it } from "vitest";
import {
  createTestAdminClient,
  deleteTestUser,
  hasTestEnv,
  removeFromWhitelist,
  uniqueTestEmail,
} from "./setup";

// Runs against a real, dedicated test Supabase project (see .env.example).
// Exercises the actual "before user created" Postgres auth hook
// (supabase/migrations/0001_auth_whitelist_and_players.sql) through the
// same GoTrue user-creation path a real OAuth sign-in goes through, rather
// than calling the SQL function directly — the function's execute grant is
// deliberately restricted to supabase_auth_admin, so the hook can only be
// exercised end-to-end, which is also the more faithful test.
describe.skipIf(!hasTestEnv)("whitelist gate (before-user-created hook)", () => {
  const createdUserIds: string[] = [];
  const seededEmails: string[] = [];

  afterEach(async () => {
    const admin = createTestAdminClient();
    await Promise.all(createdUserIds.splice(0).map((id) => deleteTestUser(admin, id)));
    await Promise.all(
      seededEmails.splice(0).map((email) => removeFromWhitelist(admin, email)),
    );
  });

  it("rejects a non-whitelisted identity outright — no user, no session", async () => {
    const admin = createTestAdminClient();
    const email = uniqueTestEmail("rejected");

    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { sub: "fake-google-sub-rejected", name: "Rejected Person" },
    });

    expect(error).not.toBeNull();
    expect(data.user).toBeNull();

    const { data: lookup } = await admin.auth.admin.listUsers();
    expect(lookup.users.some((u) => u.email === email)).toBe(false);
  });

  it("accepts a whitelisted identity and reaches a created user", async () => {
    const admin = createTestAdminClient();
    const email = uniqueTestEmail("accepted");
    seededEmails.push(email);

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
    if (data.user) createdUserIds.push(data.user.id);
    expect(data.user?.email).toBe(email);
  });

  it("whitelist matching is case-insensitive on email", async () => {
    const admin = createTestAdminClient();
    const email = uniqueTestEmail("MixedCase");
    seededEmails.push(email.toLowerCase());

    await admin.from("whitelist").insert({ email: email.toLowerCase() });

    const { data, error } = await admin.auth.admin.createUser({
      email: email.toUpperCase(),
      email_confirm: true,
      user_metadata: { sub: "fake-google-sub-mixed-case" },
    });

    expect(error).toBeNull();
    expect(data.user).not.toBeNull();
    if (data.user) createdUserIds.push(data.user.id);
  });
});
