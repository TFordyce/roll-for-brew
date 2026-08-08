import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// stats_brew_rating_{all_time,last_30_days} views added in
// supabase/migrations/0059_stats_brew_rating.sql (issue #210, part of
// #208) -- the average-score aggregate over brew_ratings (0058). Seeds
// resolved rounds and brew_ratings rows directly via the admin client
// (bypassing RLS, submit_brew_rating, and the full roll/resolve flow), the
// same "pin the timestamp to a known instant" approach stats.test.ts and
// brew-ratings.test.ts use, since the last-30-days cutoff hinges on
// brew_ratings.created_at.
describe.skipIf(!hasAnonTestEnv)("brew rating stats views", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  function signUp(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }

  async function seedResolvedRound(options: {
    roomId: string;
    startedBy: string;
    brewerId: string;
    participantIds: string[];
    resolvedAt: Date;
  }) {
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: options.roomId,
        started_by: options.startedBy,
        status: "resolved",
        brewer_id: options.brewerId,
        cups_made: 1,
        resolved_at: options.resolvedAt.toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;

    const roundId = data.id as string;
    cleanup.trackRound(roundId);

    const { error: participantsError } = await admin
      .from("round_participants")
      .insert(options.participantIds.map((playerId) => ({ round_id: roundId, player_id: playerId })));
    if (participantsError) throw participantsError;

    return roundId;
  }

  // Seeds a brew_ratings row directly (bypassing submit_brew_rating) so
  // created_at can be pinned to a known instant, the same reason
  // stats.test.ts's seedAdjustment bypasses log_modifier_adjustment.
  async function seedRating(options: {
    roundId: string;
    brewerId: string;
    raterPlayerId: string;
    score: number;
    createdAt: Date;
  }) {
    const { error } = await admin.from("brew_ratings").insert({
      round_id: options.roundId,
      brewer_id: options.brewerId,
      rater_player_id: options.raterPlayerId,
      score: options.score,
      created_at: options.createdAt.toISOString(),
    });
    if (error) throw error;
  }

  // Creates a standalone room (not the shared daily one) so a resolved
  // round's brew_ratings can be attributed to it, mirroring stats.test.ts's
  // pattern of seeding rounds against explicit rooms for cutoff/exclusion
  // tests. Tracked via cleanup.trackRoom for teardown.
  async function createRoom(options: { isTest: boolean }) {
    const { data, error } = await admin
      .from("rooms")
      .insert({ is_test: options.isTest })
      .select("id")
      .single();
    if (error) throw error;

    const roomId = data.id as string;
    cleanup.trackRoom(roomId);
    return roomId;
  }

  it("stats_brew_rating_{all_time,last_30_days} average a brewer's scores across multiple raters", async () => {
    const brewer = await signUp("bratestats-avg-brewer");
    const raterA = await signUp("bratestats-avg-ratera");
    const raterB = await signUp("bratestats-avg-raterb");
    const now = new Date();

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, raterA.googleSub, raterB.googleSub],
      resolvedAt: now,
    });
    await seedRating({
      roundId,
      brewerId: brewer.googleSub,
      raterPlayerId: raterA.googleSub,
      score: 4,
      createdAt: now,
    });
    await seedRating({
      roundId,
      brewerId: brewer.googleSub,
      raterPlayerId: raterB.googleSub,
      score: 2,
      createdAt: now,
    });

    const { data: allTime, error: allTimeError } = await brewer.client
      .from("stats_brew_rating_all_time")
      .select("player_id, average_score")
      .eq("player_id", brewer.googleSub)
      .maybeSingle();
    expect(allTimeError).toBeNull();
    expect(Number(allTime?.average_score)).toBe(3);

    const { data: last30, error: last30Error } = await brewer.client
      .from("stats_brew_rating_last_30_days")
      .select("player_id, average_score")
      .eq("player_id", brewer.googleSub)
      .maybeSingle();
    expect(last30Error).toBeNull();
    expect(Number(last30?.average_score)).toBe(3);
  });

  it("aggregates across raters despite RLS hiding individual rows from the brewer (view runs unrestricted, not security_invoker)", async () => {
    const brewer = await signUp("bratestats-rls-brewer");
    const rater = await signUp("bratestats-rls-rater");
    const now = new Date();

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: now,
    });
    await seedRating({
      roundId,
      brewerId: brewer.googleSub,
      raterPlayerId: rater.googleSub,
      score: 5,
      createdAt: now,
    });

    // The brewer can't see the rater's row directly (0058's RLS)...
    const { data: rawRow } = await brewer.client.from("brew_ratings").select("id").eq("round_id", roundId).maybeSingle();
    expect(rawRow).toBeNull();

    // ...but the aggregate view still reflects it when the brewer queries it.
    const { data, error } = await brewer.client
      .from("stats_brew_rating_all_time")
      .select("average_score")
      .eq("player_id", brewer.googleSub)
      .maybeSingle();
    expect(error).toBeNull();
    expect(Number(data?.average_score)).toBe(5);
  });

  it("excludes ratings from a test room", async () => {
    const brewer = await signUp("bratestats-testroom-brewer");
    const rater = await signUp("bratestats-testroom-rater");
    const now = new Date();

    const testRoomId = await createRoom({ isTest: true });
    const roundId = await seedResolvedRound({
      roomId: testRoomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: now,
    });
    await seedRating({
      roundId,
      brewerId: brewer.googleSub,
      raterPlayerId: rater.googleSub,
      score: 5,
      createdAt: now,
    });

    const { data, error } = await brewer.client
      .from("stats_brew_rating_all_time")
      .select("average_score")
      .eq("player_id", brewer.googleSub)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("stats_brew_rating_last_30_days excludes a rating backdated past the 30-day window", async () => {
    const brewer = await signUp("bratestats-window-brewer");
    const rater = await signUp("bratestats-window-rater");
    const now = new Date();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: fortyDaysAgo,
    });
    await seedRating({
      roundId,
      brewerId: brewer.googleSub,
      raterPlayerId: rater.googleSub,
      score: 1,
      createdAt: fortyDaysAgo,
    });

    const { data: allTime, error: allTimeError } = await brewer.client
      .from("stats_brew_rating_all_time")
      .select("average_score")
      .eq("player_id", brewer.googleSub)
      .maybeSingle();
    expect(allTimeError).toBeNull();
    expect(Number(allTime?.average_score)).toBe(1);

    const { data: last30, error: last30Error } = await brewer.client
      .from("stats_brew_rating_last_30_days")
      .select("average_score")
      .eq("player_id", brewer.googleSub)
      .maybeSingle();
    expect(last30Error).toBeNull();
    expect(last30).toBeNull();
  });

  it("returns no row (not a zero) for a brewer with no ratings", async () => {
    const brewer = await signUp("bratestats-none-brewer");

    const { data, error } = await brewer.client
      .from("stats_brew_rating_all_time")
      .select("average_score")
      .eq("player_id", brewer.googleSub)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("exposes no count column at all", async () => {
    const brewer = await signUp("bratestats-nocount-brewer");
    const rater = await signUp("bratestats-nocount-rater");
    const now = new Date();

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: now,
    });
    await seedRating({
      roundId,
      brewerId: brewer.googleSub,
      raterPlayerId: rater.googleSub,
      score: 3,
      createdAt: now,
    });

    const { data, error } = await brewer.client
      .from("stats_brew_rating_all_time")
      .select("*")
      .eq("player_id", brewer.googleSub)
      .maybeSingle();
    expect(error).toBeNull();
    expect(Object.keys(data ?? {}).sort()).toEqual(["average_score", "player_id"]);
  });
});
