import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";
import { getMyRateableRound, submitBrewRating, withdrawBrewRating } from "@/lib/supabase/brewRatings";

// Runs against a real, dedicated test Supabase project. Exercises
// src/lib/supabase/brewRatings.ts (issue #211): getMyRateableRound, the
// "does this player have something to rate right now" lookup that drives
// the rating panel's three states in the real room UI, in place of the
// prototype's manual state buttons; and the submitBrewRating/
// withdrawBrewRating wrappers the panel's Rate/stamp interactions call —
// the RPCs themselves are already covered end-to-end by
// tests/integration/brew-ratings.test.ts, so these just confirm the thin
// wrapper functions call through and getMyRateableRound reflects the
// result. Seeds resolved rounds directly via the admin client the same way
// that file does, so resolved_at can be pinned for the Most Recent Round /
// Rating Window rules.
describe.skipIf(!hasAnonTestEnv)("getMyRateableRound", () => {
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

  it("returns null when the caller has never participated in a resolved round", async () => {
    const player = await signUp("brewrate-elig-nothing");

    const result = await getMyRateableRound(player.client, player.googleSub);
    expect(result).toBeNull();
  });

  it("returns the round, unrated, for a non-brewer participant of a resolved round", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-elig-pending-brewer"),
      signUp("brewrate-elig-pending-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const result = await getMyRateableRound(rater.client, rater.googleSub);
    expect(result?.roundId).toBe(roundId);
    expect(result?.myScore).toBeNull();
  });

  it("reflects the caller's own committed score once they've rated", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-elig-rated-brewer"),
      signUp("brewrate-elig-rated-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    await rater.client.rpc("submit_brew_rating", { p_round_id: roundId, p_score: 5 });

    const result = await getMyRateableRound(rater.client, rater.googleSub);
    expect(result?.roundId).toBe(roundId);
    expect(result?.myScore).toBe(5);
  });

  it("returns null (nothing to rate) once a newer round in the room has resolved (Rating Window closed)", async () => {
    const [brewer, rater, other] = await Promise.all([
      signUp("brewrate-elig-window-brewer"),
      signUp("brewrate-elig-window-rater"),
      signUp("brewrate-elig-window-other"),
    ]);

    await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // A later round the rater didn't participate in still closes the
    // window, matching submit_brew_rating's own RFB27 rule.
    await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, other.googleSub],
      resolvedAt: new Date(),
    });

    const result = await getMyRateableRound(rater.client, rater.googleSub);
    expect(result).toBeNull();
  });

  it("only ever surfaces the caller's most-recent non-brewer round", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-elig-recent-brewer"),
      signUp("brewrate-elig-recent-rater"),
    ]);

    await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const newerRoundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const result = await getMyRateableRound(rater.client, rater.googleSub);
    expect(result?.roundId).toBe(newerRoundId);
  });

  it("returns null for a round the caller brewed themself", async () => {
    const [brewer, other] = await Promise.all([
      signUp("brewrate-elig-selfbrew-brewer"),
      signUp("brewrate-elig-selfbrew-other"),
    ]);

    await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, other.googleSub],
      resolvedAt: new Date(),
    });

    const result = await getMyRateableRound(brewer.client, brewer.googleSub);
    expect(result).toBeNull();
  });
});

describe.skipIf(!hasAnonTestEnv)("submitBrewRating / withdrawBrewRating wrappers", () => {
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

  it("submits a rating that getMyRateableRound then reflects as myScore", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-wrap-submit-brewer"),
      signUp("brewrate-wrap-submit-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const ratingId = await submitBrewRating(rater.client, roundId, 4);
    expect(ratingId).toBeTruthy();

    const result = await getMyRateableRound(rater.client, rater.googleSub);
    expect(result?.myScore).toBe(4);
  });

  it("withdraws a rating that getMyRateableRound then reflects as unrated", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-wrap-withdraw-brewer"),
      signUp("brewrate-wrap-withdraw-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    await submitBrewRating(rater.client, roundId, 2);
    await withdrawBrewRating(rater.client, roundId);

    const result = await getMyRateableRound(rater.client, rater.googleSub);
    expect(result?.myScore).toBeNull();
  });

  it("rejects an out-of-range score, surfaced as a thrown error", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-wrap-range-brewer"),
      signUp("brewrate-wrap-range-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    await expect(submitBrewRating(rater.client, roundId, 6)).rejects.toMatchObject({ code: "RFB22" });
  });
});
