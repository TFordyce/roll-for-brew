import { afterEach, describe, expect, it } from "vitest";
import {
  createTestAdminClient,
  deleteTestUser,
  hasTestEnv,
  removeFromWhitelist,
  uniqueTestEmail,
} from "./setup";

// Verifies the on_auth_user_upsert_player trigger
// (supabase/migrations/0001_auth_whitelist_and_players.sql) populates and
// keeps public.players in sync with the Google identity, for a whitelisted
// user only.
describe.skipIf(!hasTestEnv)("players table upsert from Google identity", () => {
  const createdUserIds: string[] = [];
  const seededEmails: string[] = [];

  afterEach(async () => {
    const admin = createTestAdminClient();
    for (const id of createdUserIds.splice(0)) {
      await admin.from("players").delete().eq("id", id);
      await deleteTestUser(admin, id);
    }
    await Promise.all(
      seededEmails.splice(0).map((email) => removeFromWhitelist(admin, email)),
    );
  });

  it("creates a players row keyed by Google sub on first login", async () => {
    const admin = createTestAdminClient();
    const email = uniqueTestEmail("first-login");
    seededEmails.push(email.toLowerCase());
    await admin.from("whitelist").insert({ email: email.toLowerCase() });

    const googleSub = `google-sub-${Date.now()}`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        sub: googleSub,
        name: "First Login Player",
        avatar_url: "https://example.com/first.png",
      },
    });
    expect(error).toBeNull();
    if (data.user) createdUserIds.push(data.user.id);

    const { data: player, error: playerError } = await admin
      .from("players")
      .select("id, email, display_name, avatar_url")
      .eq("id", googleSub)
      .single();

    expect(playerError).toBeNull();
    expect(player).toMatchObject({
      id: googleSub,
      email,
      display_name: "First Login Player",
      avatar_url: "https://example.com/first.png",
    });
  });

  it("upserts (not duplicates) the players row when the Google profile changes on a later login", async () => {
    const admin = createTestAdminClient();
    const email = uniqueTestEmail("returning");
    seededEmails.push(email.toLowerCase());
    await admin.from("whitelist").insert({ email: email.toLowerCase() });

    const googleSub = `google-sub-returning-${Date.now()}`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { sub: googleSub, name: "Old Name" },
    });
    expect(error).toBeNull();
    const userId = data.user!.id;
    createdUserIds.push(userId);

    await admin.auth.admin.updateUserById(userId, {
      user_metadata: {
        sub: googleSub,
        name: "New Name",
        avatar_url: "https://example.com/new.png",
      },
    });

    const { data: players, error: playersError } = await admin
      .from("players")
      .select("id, display_name, avatar_url")
      .eq("id", googleSub);

    expect(playersError).toBeNull();
    expect(players).toHaveLength(1);
    expect(players?.[0]).toMatchObject({
      id: googleSub,
      display_name: "New Name",
      avatar_url: "https://example.com/new.png",
    });
  });
});
