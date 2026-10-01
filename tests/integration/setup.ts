import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { STALL_TIMEOUT_MS } from "../../src/lib/game/stallTimeout";

export const TEST_URL = process.env.SUPABASE_TEST_URL;
export const TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
export const TEST_SERVICE_ROLE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

/**
 * A fixed instant just past the 5-minute closed-round stall window, for
 * enforceStallTimeout's injectable `now` — lets a stall-timeout test fire
 * the timer without sleeping ~5 minutes for real.
 */
export function stallTimeoutFuture(): Date {
  return new Date(Date.now() + STALL_TIMEOUT_MS + 5_000);
}

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
 * Creates a fresh room with `is_test = false` and returns its id.
 *
 * `rooms.date` is nullable (0024, for the dateless Test Room), so this
 * leaves it null -- the `rooms_date_key` partial unique index is on `date`
 * `where not is_test`, and NULLs never collide there, so every call yields
 * an independent room with no date bookkeeping.
 *
 * ADR 0002 frames a null `rooms.date` as the Test Room's property and warns
 * that sentinel dates "read as real data"; a null-dated non-test room is the
 * mirror-image anomaly. It's tolerated here because it never leaves the test
 * suite: nothing in the app creates one, and `stats_room_history` (the only
 * reader that surfaces `date`) just sorts it last.
 *
 * `rounds`, `round_participants` and `rooms` are all world-readable to
 * `authenticated` (RLS `using (true)`), so a signed-in client reads back
 * rounds seeded here with no room_players membership needed.
 */
export async function seedNonTestRoom(
  admin: SupabaseClient,
  cleanup: ReturnType<typeof createTestCleanup>,
) {
  const { data, error } = await admin
    .from("rooms")
    .insert({ is_test: false })
    .select("id")
    .single();
  if (error) throw error;
  const roomId = (data as { id: string }).id;
  cleanup.trackRoom(roomId);
  return roomId;
}

/**
 * `signUpSignInAndEnterRoom` but with `roomId` pointing at a fresh
 * `seedNonTestRoom` instead of today's shared room.
 *
 * Use this in any file that asserts on the `stats_*` views (they filter
 * `not rooms.is_test`) or anything else gated on a room's `is_test` flag:
 * today's shared room is joined by every `signUpSignInAndEnterRoom` call and
 * never deleted per test, and it collects every round another file resolved
 * there today (which closes the Order and Rating windows) and every player a
 * teardown leaked. Seeding into an own room sidesteps all of that.
 */
export async function signUpSignInIntoNonTestRoom(
  admin: SupabaseClient,
  cleanup: ReturnType<typeof createTestCleanup>,
  label: string,
) {
  const player = await signUpSignInAndEnterRoom(admin, cleanup, label);
  const roomId = await seedNonTestRoom(admin, cleanup);
  return { ...player, roomId };
}

/**
 * A fresh null-dated room whose room_players are exactly `playerIds`
 * (modifier 0), for tests that start real rounds and need to know who else is
 * in the room — pass the id to `start_round({ p_room_id })`. Today's shared
 * room collects every player a teardown ever leaked, so a room-wide pick
 * (Wild Brew Surge's random swap partner, say) can land on a stranger there
 * (issue #422).
 *
 * `isTest: true` gives an admin-puppet Test Room (submit_roll_as,
 * draw_spell_card_as) without flipping today's shared room: once that one is
 * `is_test`, enter_todays_room makes a second today-dated room and it and
 * start_round() then pick between them arbitrarily.
 */
export async function seedDedicatedRoom(
  admin: SupabaseClient,
  cleanup: ReturnType<typeof createTestCleanup>,
  playerIds: string[],
  opts: { isTest?: boolean } = {},
) {
  const { data, error: roomError } = await admin
    .from("rooms")
    .insert({ is_test: opts.isTest ?? false })
    .select("id")
    .single();
  if (roomError) throw roomError;
  const roomId = (data as { id: string }).id;
  cleanup.trackRoom(roomId);
  const { error } = await admin
    .from("room_players")
    .insert(playerIds.map((player_id) => ({ room_id: roomId, player_id })));
  if (error) throw error;
  return roomId;
}

/**
 * Seeds a past round in `roomId` directly (admin bypasses RLS): its
 * participants and layer-0 rolls, with `status` (default 'resolved') and a
 * `started_at` in the past so it sorts before any round opened afterwards.
 * For cards that read an earlier round, e.g. Last Drip (issue #426).
 */
export async function seedPastRound(
  admin: SupabaseClient,
  cleanup: ReturnType<typeof createTestCleanup>,
  roomId: string,
  rolls: { playerId: string; value: number; modifierSnapshot?: number }[],
  opts: { status?: "resolved" | "cancelled"; minutesAgo?: number } = {},
) {
  const startedAt = new Date(Date.now() - (opts.minutesAgo ?? 60) * 60_000);
  const status = opts.status ?? "resolved";
  const { data, error } = await admin
    .from("rounds")
    .insert({
      room_id: roomId,
      started_by: rolls[0]!.playerId,
      status,
      started_at: startedAt.toISOString(),
      resolved_at: status === "resolved" ? startedAt.toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw error;
  const roundId = (data as { id: string }).id;
  cleanup.trackRound(roundId);

  const { error: pErr } = await admin
    .from("round_participants")
    .insert(rolls.map((r) => ({ round_id: roundId, player_id: r.playerId })));
  if (pErr) throw pErr;
  const { error: rErr } = await admin.from("rolls").insert(
    rolls.map((r) => ({
      round_id: roundId,
      player_id: r.playerId,
      layer: 0,
      value: r.value,
      input_mode: "manual",
      modifier_snapshot: r.modifierSnapshot ?? 0,
    })),
  );
  if (rErr) throw rErr;
  return roundId;
}

/**
 * The non-working spell cards still parked at location 'benched' (migration
 * 0074, issue #284) so draw_spell_card skips them. Kept in sync by hand as
 * each card is implemented and un-benched: 0074 benched 39; Yorkshire Terror
 * (#286, migration 0075), Saving Steep (#308, migration 0081), the four ward
 * cards — Jinxed Biscuit, Cast-Iron Kettle, Bag for Life, Eternal Steep
 * (#309, migration 0082) — the three round-scoped modifier snapshot cards —
 * Bes-Tea, Tea Leaf, Spillage (#343, migration 0087) — the three durable
 * persistent-modifier cards — Chai-nge of Heart, Tea-tally Spent, Bitter
 * Leech (#342, migration 0088) — the three Effect Invocation cards —
 * Saucerer's Apprentice, Genie in the Teapot, Brew-merang (#316, migration
 * 0093) — the four chosen-pair roll-transform cards — Brew-tal Swap, Stir the
 * Pot, Steaming Mug Bond, Tea for Two (#318, migration 0096) — Gambler's
 * Infusion (conditional advantage, #319, migration 0095) — the two
 * fixed-roll cards — Steady Hand, Sleeping Camomile (#317, migration 0094) —
 * Prophe-Tea (persistent advantage, #320, migration 0097) — Cloud of Cream
 * (targeting skip, #321, migration 0099) — Tea Heist (#438, migration 0117) —
 * Brewmageddon (Compelled Cast, #440, migration 0119) — Last Drip (#426,
 * migration 0124) — PG Tipped (conditional override, #427, migration 0126) —
 * The Last Cuppa (brewer immunity, #428, migration 0128) — Tea Party Revolt
 * (lowest roller picks, #430, migration 0131) — Earl of Earl Grey (#429,
 * migration 0133) — Loose Leaf (roll-off, #431, migration 0135) — Brew IOU
 * (Brew Debt, #432, migration 0137) — Loaf of Lipton (Roll Exemption,
 * #433, migration 0139) — and Tea Cosy (immunity + Roll Exemption, #434,
 * migration 0141) — are now live, so 4 remain here. A test that force-holds
 * one of these must return it to the bench, not the deck, on cleanup —
 * releaseHeldCards below does that.
 */
export const BENCHED_SPELL_CARDS = [
  // No effect rows
  "Marked for Brew",
  "Stale Biscuit", "Liquid Courage",
  // Dead effect kind (1)
  "Kettle Crash",
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

export type RoundModifierEffectRow = {
  target_player_id: string;
  effect_kind: string;
  effect_params: Record<string, unknown>;
  resolved_value: number | null;
  card_name: string;
  caster_player_id: string;
};

const ROUND_CAST_EFFECT_KINDS = [
  "flat_modifier",
  "dice_modifier",
  "modifier_multiplier",
  "set_modifier",
  "advantage",
  "disadvantage",
];
const CARRIED_EFFECT_KINDS = ["flat_modifier", "dice_modifier", "modifier_multiplier", "set_modifier"];

/**
 * Test-only observation seam: the modifier-bucket effects a round's Cast Log
 * and active effects carry, in the row shape the retired
 * get_round_modifier_effects RPC returned. That RPC fed the TS badge
 * recomposition #402 deleted (ADR 0007); the production app now reads the
 * resolver's Resolution Summary instead, but these tests still want to see
 * "this cast landed as this effect on this player" before any roll exists.
 *
 * Same rows as the RPC: live (not negated, target set) casts of the modifier
 * / advantage kinds from non-persistent cards, plus the live carried-forward
 * modifier effects (via `client`, which `_rr_active_effects_as_of` is granted
 * to), ordered by cast / creation time.
 */
export async function roundModifierEffects(
  admin: SupabaseClient,
  client: SupabaseClient,
  roundId: string,
): Promise<{ data: RoundModifierEffectRow[] | null; error: Error | null }> {
  const { data: round, error: rErr } = await admin.from("rounds").select("room_id").eq("id", roundId).single();
  if (rErr) return { data: null, error: rErr };

  const { data: casts, error: cErr } = await admin
    .from("spell_casts")
    .select(
      "target_player_id, effect_kind, effect_params, cast_inputs, caster_id, cast_at, spell_deck_instances!inner(spell_cards!inner(name, duration_rounds))",
    )
    .eq("round_id", roundId)
    .eq("target_pending", false)
    .eq("negated", false)
    .in("effect_kind", ROUND_CAST_EFFECT_KINDS);
  if (cErr) return { data: null, error: cErr };

  const { data: carried, error: aErr } = await admin.rpc("_rr_active_effects_as_of", {
    p_room_id: round!.room_id,
    p_as_of_round_id: roundId,
  });
  if (aErr) return { data: null, error: aErr };
  const carriedRows = ((carried ?? []) as {
    target_player_id: string;
    effect_kind: string;
    effect_params: Record<string, unknown>;
    caster_id: string;
    card_id: string;
    created_at: string;
  }[]).filter((e) => CARRIED_EFFECT_KINDS.includes(e.effect_kind));
  const cardIds = [...new Set(carriedRows.map((e) => e.card_id))];
  const { data: cards, error: kErr } = cardIds.length
    ? await admin.from("spell_cards").select("id, name").in("id", cardIds)
    : { data: [], error: null };
  if (kErr) return { data: null, error: kErr };
  const cardName = new Map((cards ?? []).map((c) => [c.id as string, c.name as string]));

  type Card = { name: string; duration_rounds: number | null };
  const rows: (RoundModifierEffectRow & { ts: string })[] = [
    ...(casts ?? [])
      .filter((c) => {
        const card = (c.spell_deck_instances as unknown as { spell_cards: Card }).spell_cards;
        return card.duration_rounds === null;
      })
      .map((c) => {
        const card = (c.spell_deck_instances as unknown as { spell_cards: Card }).spell_cards;
        const inputs = (c.cast_inputs ?? {}) as { dice_roll?: number };
        const params = (c.effect_params ?? {}) as { sign?: number };
        return {
          target_player_id: c.target_player_id as string,
          effect_kind: c.effect_kind as string,
          effect_params: c.effect_params as Record<string, unknown>,
          resolved_value:
            c.effect_kind === "dice_modifier" && inputs.dice_roll != null
              ? Number(inputs.dice_roll) * (params.sign ?? 1)
              : null,
          card_name: card.name,
          caster_player_id: c.caster_id as string,
          ts: c.cast_at as string,
        };
      }),
    ...carriedRows.map((e) => ({
      target_player_id: e.target_player_id,
      effect_kind: e.effect_kind,
      effect_params: e.effect_params,
      resolved_value: null,
      card_name: cardName.get(e.card_id) ?? "",
      caster_player_id: e.caster_id,
      ts: e.created_at,
    })),
  ];
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { data: rows.map(({ ts: _ts, ...row }) => row), error: null };
}

/**
 * Narrows a room-scoped result (roundModifierEffects,
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
 * Test-only observation seam: whether a round's Layer is complete, from the
 * same `_layer_is_complete` rules round advancement uses (every expected
 * roller has rolled and, at Layer 0, no Pending Spell Die or Deferred
 * Forced-Reroll Target hold). Internal to advancement, so read as the
 * service role.
 */
export async function isLayerComplete(admin: SupabaseClient, roundId: string, layer: number): Promise<boolean> {
  const { data, error } = await admin.rpc("_layer_is_complete", { p_round_id: roundId, p_layer: layer });
  if (error) throw error;
  return data as boolean;
}

export type LayerRollRow = {
  player_id: string;
  value: number;
  modifier_snapshot: number;
  discarded_value: number | null;
  entered_by_admin: boolean;
};

/**
 * Test-only observation seam: a Layer's rolls read directly as the service
 * role (rolls stay hidden from players until reveal), ordered by player.
 */
export async function getLayerRolls(admin: SupabaseClient, roundId: string, layer: number): Promise<LayerRollRow[]> {
  const { data, error } = await admin
    .from("rolls")
    .select("player_id, value, modifier_snapshot, discarded_value, entered_by_admin")
    .eq("round_id", roundId)
    .eq("layer", layer)
    .order("player_id");
  if (error) throw error;
  return (data ?? []) as LayerRollRow[];
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

  /**
   * Deletes the tracked rounds concurrently, retrying any that fail until a
   * pass makes no progress. Until 0116 (issue #441), spell_casts.source_cast_id
   * had no ON DELETE clause and points across rounds — a later round's Bitter
   * Leech / Calami-Tea tick rows reference the earlier round's cast — so the
   * earlier round's delete was rejected whenever it raced ahead of the later
   * one. That used to fail silently, leaving the round's casts to block the
   * player delete below with a spell_casts_*_player_id_fkey error (issue #422).
   * That FK is now ON DELETE SET NULL; the retry stays as a guard for any other
   * backwards cross-round reference. Such references always point backwards,
   * so each pass frees at least one round; a pass with no progress is a real
   * leak and throws.
   */
  async function deleteRounds(ids: string[]) {
    let pending = ids;
    while (pending.length > 0) {
      const results = await Promise.all(
        pending.map(async (roundId) => {
          const { error } = await admin.from("rounds").delete().eq("id", roundId);
          return { roundId, error };
        }),
      );
      const failed = results.filter((r) => r.error);
      if (failed.length === pending.length) {
        throw new Error(
          `cleanup: could not delete rounds ${failed.map((f) => f.roundId).join(", ")}: ` +
            failed[0]!.error!.message,
        );
      }
      pending = failed.map((f) => f.roundId);
    }
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
      await deleteRounds(roundIds.splice(0));
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
