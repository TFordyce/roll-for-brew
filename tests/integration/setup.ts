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
 *
 * The sign-in is passwordless: the user is created with no password and the
 * session is minted from an admin-generated magiclink. Password create +
 * password verify were each a bcrypt op at GoTrue's default cost (~350 ms of
 * the ~590 ms per user) and dominated the suite's wall-clock (issue #332).
 * verifyOtp still runs GoTrue's real token-issuance path, so the
 * custom_access_token hook — and therefore the per-login whitelist
 * revocation check — is exercised exactly as a password sign-in would be.
 * (whitelist-gate.test.ts keeps a dedicated password sign-in for the
 * revocation assertion.)
 */
export async function signUpSignInAndEnterRoom(
  admin: SupabaseClient,
  cleanup: ReturnType<typeof createTestCleanup>,
  label: string,
) {
  const email = uniqueTestEmail(label);
  const googleSub = `google-sub-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  cleanup.trackWhitelistedEmail(email);
  cleanup.trackPlayerId(googleSub);

  await admin.from("whitelist").insert({ email: email.toLowerCase() });
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { sub: googleSub, name: `Player ${label}` },
  });
  if (error) throw error;
  cleanup.trackUser(data.user!.id);

  const client = createTestAnonClient();
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const { error: signInError } = await client.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (signInError) throw signInError;

  const { data: roomId, error: roomError } = await client.rpc("enter_todays_room");
  if (roomError) throw roomError;

  return { client, googleSub, roomId: roomId as string };
}

/**
 * The non-working spell cards still parked at location 'benched' (migration
 * 0074, issue #284) so draw_spell_card skips them. Kept in sync by hand as
 * each card is implemented and un-benched: 0074 benched 39; Saving Steep
 * (#308, migration 0081) and the four ward cards — Jinxed Biscuit,
 * Cast-Iron Kettle, Bag for Life, Eternal Steep (#309, migration 0082) — are
 * now live, so 34 remain here. A test that force-holds one of these must
 * return it to the bench, not the deck, on cleanup — releaseHeldCards below
 * does that.
 */
export const BENCHED_SPELL_CARDS = [
  // No effect rows
  "Bes-Tea", "Tea Party Revolt", "Last Drip",
  "Brew-tal Swap", "Yorkshire Terror",
  "Tea Cosy", "Tea Leaf", "Spillage", "Chai-nge of Heart",
  "Loose Leaf", "Stir the Pot", "PG Tipped",
  "Marked for Brew", "Sleeping Camomile", "Steaming Mug Bond",
  "Tea-tally Spent", "Loaf of Lipton", "Brew IOU", "Tea Heist",
  "Stale Biscuit", "Saucerer's Apprentice", "Bitter Leech", "Liquid Courage",
  "The Last Cuppa", "Earl of Earl Grey", "Prophe-Tea",
  "Genie in the Teapot",
  "Gambler's Infusion", "Steady Hand", "Brew-merang", "Tea for Two",
  "Brewmageddon",
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
 * Seeds a persistent active effect the way it exists after #310: a real
 * spell_casts row (the Cast Log anchor — spell_active_effects.source_cast_id
 * is NOT NULL) plus the projected spell_active_effects row pointing at it.
 *
 * By default the source cast lands in a fresh `resolved` round created just
 * for the seed (tracked for teardown), so the effect reads as "carried
 * forward from an earlier round" without colliding with a test's own
 * start_round (rounds_one_active_per_room only guards open/closed rounds).
 * Pass `roundId` to anchor the cast in an existing round instead.
 *
 * rounds_remaining is stored verbatim as the immutable duration snapshot
 * (#310); how many rounds are actually left is derived by
 * _rr_active_effects_as_of at read time.
 */
export async function seedActiveEffect(
  admin: SupabaseClient,
  cleanup: ReturnType<typeof createTestCleanup>,
  opts: {
    roomId: string;
    targetPlayerId: string;
    casterId: string;
    cardName: string;
    effectKind: string;
    effectParams?: Record<string, unknown>;
    roundsRemaining?: number | null;
    roundId?: string;
  },
): Promise<{ effectId: string; castId: string; roundId: string }> {
  const {
    roomId,
    targetPlayerId,
    casterId,
    cardName,
    effectKind,
    effectParams = {},
    roundsRemaining = null,
  } = opts;

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

  let roundId = opts.roundId;
  if (!roundId) {
    const { data: round, error: roundError } = await admin
      .from("rounds")
      .insert({
        room_id: roomId,
        started_by: casterId,
        status: "resolved",
        resolved_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (roundError) throw roundError;
    roundId = round.id as string;
    cleanup.trackRound(roundId);
  }

  const { data: cast, error: castError } = await admin
    .from("spell_casts")
    .insert({
      round_id: roundId,
      caster_id: casterId,
      card_instance_id: instance.id,
      target_player_id: targetPlayerId,
      target_pending: false,
      effect_kind: effectKind,
      effect_params: effectParams,
    })
    .select("id")
    .single();
  if (castError) throw castError;

  const { data: effect, error: effectError } = await admin
    .from("spell_active_effects")
    .insert({
      room_id: roomId,
      target_player_id: targetPlayerId,
      caster_id: casterId,
      source_cast_id: cast.id,
      card_id: card.id,
      effect_kind: effectKind,
      effect_params: effectParams,
      rounds_remaining: roundsRemaining,
    })
    .select("id")
    .single();
  if (effectError) throw effectError;

  return { effectId: effect.id as string, castId: cast.id as string, roundId };
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
   *
   * Player-scoped, so it's safe to run concurrently for every tracked
   * player/user in a teardown layer. The benched cards a release like this
   * un-parks are re-parked once per layer by reBenchLooseBenchedCards().
   */
  async function releaseHeldCards(playerId: string) {
    const { error } = await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("held_by_player", playerId);
    if (error) throw error;
  }

  /**
   * Any card migration 0074 parks at 'benched' (issue #284) that a test
   * force-held was just sent back to 'in_deck' by releaseHeldCards, quietly
   * un-benching it for the rest of the run. Re-park every benched card
   * sitting loose in the deck so the non-working-card pool stays out of
   * draw_spell_card. This scans the whole deck rather than one player's
   * rows, so run() calls it once per teardown layer, not once per entity.
   *
   * Gated on an existing 'benched' row so this is a no-op — and, crucially,
   * won't trip the pre-0074 three-value location check constraint — when
   * run against a DB where migration 0074 hasn't been applied.
   */
  async function reBenchLooseBenchedCards() {
    const { data: benchedProbe, error: probeErr } = await admin
      .from("spell_deck_instances")
      .select("id")
      .eq("location", "benched")
      .limit(1);
    if (probeErr) throw probeErr;
    if (!benchedProbe || benchedProbe.length === 0) return;

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
      // Teardown runs one FK layer at a time — rounds, then rooms, then
      // players, then auth users, then whitelist rows — but the entities
      // within a layer are independent, so they're deleted concurrently
      // (issue #332). The per-entity await chains below preserve the
      // child-before-parent order that matters.
      await Promise.all(
        roundIds.splice(0).map((roundId) =>
          admin.from("rounds").delete().eq("id", roundId),
        ),
      );
      await Promise.all(
        roomIds.splice(0).map(async (roomId) => {
          await admin.from("room_players").delete().eq("room_id", roomId);
          await admin.from("rooms").delete().eq("id", roomId);
        }),
      );
      await Promise.all(
        playerIds.splice(0).map(async (playerId) => {
          // spell_draws.player_id has no ON DELETE CASCADE (0018), so a row
          // forced in via forceDraw would otherwise block this delete.
          await admin.from("spell_draws").delete().eq("player_id", playerId);
          await releaseHeldCards(playerId);
          await releaseActiveEffects(playerId);
          await deletePlayer(playerId);
        }),
      );
      await reBenchLooseBenchedCards();
      await Promise.all(
        userIds.splice(0).map(async (id) => {
          await admin.from("spell_draws").delete().eq("player_id", id);
          await releaseHeldCards(id);
          await releaseActiveEffects(id);
          await deletePlayer(id);
          await deleteTestUser(admin, id);
        }),
      );
      await reBenchLooseBenchedCards();
      await Promise.all(
        whitelistedEmails.splice(0).map((email) => removeFromWhitelist(admin, email)),
      );
    },
  };
}
