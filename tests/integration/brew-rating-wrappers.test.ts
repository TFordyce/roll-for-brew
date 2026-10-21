import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";
import { submitBrewRating, withdrawBrewRating } from "@/lib/supabase/brewRatings";

// Runs against a real, dedicated test Supabase project. Exercises the
// submitBrewRating/withdrawBrewRating wrappers the rating panel's Rate/stamp
// interactions call; the RPCs themselves are covered end-to-end by
// tests/integration/brew-ratings.test.ts, so these just confirm the thin
// wrapper functions call through. Seeds resolved rounds directly via the
// admin client. (The getMyRateableRound lookup moved to the C# room view in
// #541; its rules are pinned in the API tests.)
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

  it("submits a rating and stores the score", async () => {
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

    const { data: row } = await admin.from("brew_ratings").select("score").eq("id", ratingId).single();
    expect(row?.score).toBe(4);
  });

  it("withdraws a rating so no rating remains", async () => {
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

    const { data: rows } = await admin.from("brew_ratings").select("id").eq("round_id", roundId);
    expect(rows).toEqual([]);
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
