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
 * Signs up a whitelisted test user, signs them in via the anon client (the
 * only way to drive GoTrue's real token-issuance path, same as
 * createTestAnonClient's docs above), and enters today's room — the common
 * setup every RPC-level integration test in this suite starts from.
 */
export async function signUpSignInAndEnterRoom(
  admin: SupabaseClient,
  cleanup: ReturnType<typeof createTestCleanup>,
  label: string,
) {
  const email = uniqueTestEmail(label);
  const password = `Test-password-${Math.random().toString(36).slice(2)}!`;
  const googleSub = `google-sub-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  cleanup.trackWhitelistedEmail(email);
  cleanup.trackPlayerId(googleSub);

  await admin.from("whitelist").insert({ email: email.toLowerCase() });
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { sub: googleSub, name: `Player ${label}` },
  });
  if (error) throw error;
  cleanup.trackUser(data.user!.id);

  const client = createTestAnonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  const { data: roomId, error: roomError } = await client.rpc("enter_todays_room");
  if (roomError) throw roomError;

  return { client, googleSub, roomId: roomId as string };
}

/**
 * The 39 non-working spell cards parked at location 'benched' by migration
 * 0074 (issue #284) so draw_spell_card skips them. Kept in sync with that
 * migration's name list by hand. A test that force-holds one of these must
 * return it to the bench, not the deck, on cleanup — releaseHeldCards below
 * does that.
 */
export const BENCHED_SPELL_CARDS = [
  // No effect rows (37)
  "Bes-Tea", "Tea Party Revolt", "Last Drip", "Saving Steep",
  "Brew-tal Swap", "Yorkshire Terror",
  "Tea Cosy", "Tea Leaf", "Spillage", "Chai-nge of Heart", "Bag for Life",
  "Loose Leaf", "Stir the Pot", "PG Tipped", "Jinxed Biscuit",
  "Marked for Brew", "Sleeping Camomile", "Steaming Mug Bond",
  "Tea-tally Spent", "Loaf of Lipton", "Brew IOU", "Tea Heist",
  "Stale Biscuit", "Saucerer's Apprentice", "Bitter Leech", "Liquid Courage",
  "Eternal Steep", "The Last Cuppa", "Earl of Earl Grey", "Prophe-Tea",
  "Genie in the Teapot",
  "Gambler's Infusion", "Steady Hand", "Brew-merang", "Tea for Two",
  "Cast-Iron Kettle", "Brewmageddon",
  // Dead effect kind (2)
  "Cloud of Cream", "Kettle Crash",
] as const;

/**
 * Forces a specific catalog card into a player's hand directly (admin
 * bypasses RLS) rather than relying on a random draw landing on the exact
 * card a test needs.
 */
export async function forceHold(
  admin: SupabaseClient,
  playerId: string,
  cardName: string,
): Promise<string> {
  const { data: card, error: cardError } = await admin
    .from("spell_cards")
    .select("id")
    .eq("name", cardName)
    .single();
  if (cardError) throw cardError;

  const { data: instance, error: instanceError } = await admin
    .from("spell_deck_instances")
    .select("id")
    .eq("card_id", card.id)
    .single();
  if (instanceError) throw instanceError;

  const { error: updateError } = await admin
    .from("spell_deck_instances")
    .update({ location: "held", held_by_player: playerId })
    .eq("id", instance.id);
  if (updateError) throw updateError;

  return instance.id as string;
}

/**
 * Records a spell_draws row for a specific catalog card directly (admin
 * bypasses RLS), the same "force it rather than rely on a random draw"
 * approach as forceHold above — but for draw *history* (spell_draws) rather
 * than current hold state (spell_deck_instances). Doesn't touch
 * spell_deck_instances location, so it's safe to call repeatedly against
 * the same card to build up a draw_count without fighting the one-held-
 * card-per-player constraint.
 */
export async function forceDraw(
  admin: SupabaseClient,
  playerId: string,
  cardName: string,
): Promise<void> {
  const { data: card, error: cardError } = await admin
    .from("spell_cards")
    .select("id")
    .eq("name", cardName)
    .single();
  if (cardError) throw cardError;

  const { data: instance, error: instanceError } = await admin
    .from("spell_deck_instances")
    .select("id")
    .eq("card_id", card.id)
    .single();
  if (instanceError) throw instanceError;

  const { error: drawError } = await admin
    .from("spell_draws")
    .insert({ player_id: playerId, card_instance_id: instance.id, trigger: "nat1" });
  if (drawError) throw drawError;
}

/**
 * Narrows a room-scoped RPC result (get_round_modifier_effects,
 * get_room_active_effects, get_dispellable_active_effects — all shaped with
 * a target_player_id column) down to the row(s) for one or more player ids.
 *
 * These RPCs are intentionally room-wide, not test-wide (persistent effects
 * must keep composing across every round in the room, and roster badges
 * must show every active effect on the roster) — so once the full suite
 * shares the daily room, a test asserting the RPC's *entire* result set
 * breaks as soon as another test leaves casts/effects behind in that same
 * room, even though the RPC returned exactly what it's supposed to (issue
 * #147). Player ids are generated fresh per test (signUpSignInAndEnterRoom),
 * so filtering by them is enough to isolate a test's own rows without
 * touching the RPCs themselves.
 */
export function byTarget<T extends { target_player_id: string }>(
  rows: T[],
  ...targetPlayerIds: string[]
): T[] {
  const wanted = new Set(targetPlayerIds);
  return rows.filter((row) => wanted.has(row.target_player_id));
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
  const roundIds: string[] = [];

  /**
   * Resets any spell_deck_instances row still pointing at a player back to
   * in_deck before the player row itself is deleted. held_by_player
   * references public.players(id) with no ON DELETE clause (0018) — a test
   * that forces a hold (or leaves a draw parked as pending_swap) and never
   * resolves it would otherwise block the player delete below, which
   * silently no-ops on error and permanently leaks both the orphaned
   * player row and the card's held state into later tests/runs (issue
   * #175).
   */
  async function releaseHeldCards(playerId: string) {
    const { error } = await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("held_by_player", playerId);
    if (error) throw error;

    // A test that force-held a benched card (e.g. Cloud of Cream) just sent
    // it back to 'in_deck' above, quietly un-benching it for the rest of
    // the run. Re-park any benched card sitting loose in the deck so the
    // non-working-card pool stays out of draw_spell_card (issue #284).
    //
    // Gated on an existing 'benched' row so this is a no-op — and, crucially,
    // won't trip the pre-0074 three-value location check constraint — when
    // run against a DB where migration 0074 hasn't been applied.
    const { data: benchedProbe } = await admin
      .from("spell_deck_instances")
      .select("id")
      .eq("location", "benched")
      .limit(1);
    if (benchedProbe && benchedProbe.length > 0) {
      const { data: benchedCards, error: benchedErr } = await admin
        .from("spell_cards")
        .select("id")
        .in("name", [...BENCHED_SPELL_CARDS]);
      if (benchedErr) throw benchedErr;

      const { error: reBenchErr } = await admin
        .from("spell_deck_instances")
        .update({ location: "benched", held_by_player: null })
        .is("held_by_player", null)
        .eq("location", "in_deck")
        .in(
          "card_id",
          (benchedCards ?? []).map((c) => c.id),
        );
      if (reBenchErr) throw reBenchErr;
    }
  }

  /**
   * Deletes any spell_active_effects row still referencing a player, as
   * either caster or target. Unlike spell_casts (cascades away with its
   * round, which cleanup always deletes), spell_active_effects cascades
   * only off room_id (0020) — and this suite's rooms are the shared
   * "today's room" from enter_todays_room, never deleted per test. A
   * persistent effect left active past its owning test (e.g. Calami-Tea's
   * immediate-resolve CHOSEN_PLAYERS effect) would otherwise block the
   * caster's or target's player delete below the same way held cards did
   * (issue #175).
   */
  async function releaseActiveEffects(playerId: string) {
    const { error } = await admin
      .from("spell_active_effects")
      .delete()
      .or(`caster_id.eq.${playerId},target_player_id.eq.${playerId}`);
    if (error) throw error;
  }

  async function deletePlayer(playerId: string) {
    const { error } = await admin.from("players").delete().eq("id", playerId);
    if (error) throw error;
  }

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
    /**
     * Tracks a public.rounds.id created via start_round/direct seeding.
     * Rounds created against *today's* shared room can't be cleaned up by
     * deleting the room (other tests/real usage share it), so they need
     * their own teardown; round_participants cascade off the round.
     */
    trackRound(roundId: string) {
      roundIds.push(roundId);
    },
    async run() {
      for (const roundId of roundIds.splice(0)) {
        await admin.from("rounds").delete().eq("id", roundId);
      }
      for (const roomId of roomIds.splice(0)) {
        await admin.from("room_players").delete().eq("room_id", roomId);
        await admin.from("rooms").delete().eq("id", roomId);
      }
      for (const playerId of playerIds.splice(0)) {
        // spell_draws.player_id has no ON DELETE CASCADE (0018), so a row
        // forced in via forceDraw would otherwise block this delete.
        await admin.from("spell_draws").delete().eq("player_id", playerId);
        await releaseHeldCards(playerId);
        await releaseActiveEffects(playerId);
        await deletePlayer(playerId);
      }
      for (const id of userIds.splice(0)) {
        await admin.from("spell_draws").delete().eq("player_id", id);
        await releaseHeldCards(id);
        await releaseActiveEffects(id);
        await deletePlayer(id);
        await deleteTestUser(admin, id);
      }
      await Promise.all(
        whitelistedEmails.splice(0).map((email) => removeFromWhitelist(admin, email)),
      );
    },
  };
}
