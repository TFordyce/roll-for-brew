import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// brew_ratings table and the submit_brew_rating/withdraw_brew_rating RPCs
// added in supabase/migrations/0058_brew_ratings.sql (issue #209, part of
// #208). Seeds resolved rounds directly via the admin client (bypassing RLS
// and the full roll/resolve RPC flow), the same "pin resolved_at to a known
// instant" approach stats.test.ts uses, since the Most Recent Round and
// Rating Window rules both hinge on resolved_at ordering.
describe.skipIf(!hasAnonTestEnv)("brew ratings: submit and withdraw", () => {
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

  it("submits a rating for a non-brewer participant of a resolved round", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-submit-brewer"),
      signUp("brewrate-submit-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const { data: ratingId, error } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 4,
    });
    expect(error).toBeNull();
    expect(ratingId).toBeTruthy();

    const { data: row } = await admin
      .from("brew_ratings")
      .select("round_id, brewer_id, rater_player_id, score")
      .eq("id", ratingId)
      .single();
    expect(row).toEqual({
      round_id: roundId,
      brewer_id: brewer.googleSub,
      rater_player_id: rater.googleSub,
      score: 4,
    });
  });

  it("edits the same row on a second submit for the same round (upsert, no duplicate)", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-edit-brewer"),
      signUp("brewrate-edit-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const { data: firstId } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 2,
    });
    const { data: secondId, error } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 5,
    });
    expect(error).toBeNull();
    expect(secondId).toBe(firstId);

    const { data: rows } = await admin.from("brew_ratings").select("id, score").eq("round_id", roundId);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.score).toBe(5);
  });

  it("rejects the brewer rating themself (RFB25)", async () => {
    const [brewer, other] = await Promise.all([
      signUp("brewrate-self-brewer"),
      signUp("brewrate-self-other"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, other.googleSub],
      resolvedAt: new Date(),
    });

    const { error } = await brewer.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 3,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB25");
  });

  it("rejects a non-participant (RFB24)", async () => {
    const [brewer, participant, outsider] = await Promise.all([
      signUp("brewrate-outsider-brewer"),
      signUp("brewrate-outsider-participant"),
      signUp("brewrate-outsider-outsider"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, participant.googleSub],
      resolvedAt: new Date(),
    });

    const { error } = await outsider.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 3,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB24");
  });

  it("rejects a score outside 1-5 (RFB22)", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-range-brewer"),
      signUp("brewrate-range-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const { error } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 6,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB22");
  });

  it("rejects a round that does not exist or is not resolved (RFB23)", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-unresolved-brewer"),
      signUp("brewrate-unresolved-rater"),
    ]);

    const { data, error: insertError } = await admin
      .from("rounds")
      .insert({
        room_id: brewer.roomId,
        started_by: brewer.googleSub,
        status: "open",
        brewer_id: null,
      })
      .select("id")
      .single();
    expect(insertError).toBeNull();
    const roundId = data!.id as string;
    cleanup.trackRound(roundId);

    await admin.from("round_participants").insert([
      { round_id: roundId, player_id: brewer.googleSub },
      { round_id: roundId, player_id: rater.googleSub },
    ]);

    const { error } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 3,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB23");
  });

  it("rejects rating a round that isn't the caller's most-recent non-brewer round (RFB26)", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-stale-brewer"),
      signUp("brewrate-stale-rater"),
    ]);

    const olderRoundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const { error } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: olderRoundId,
      p_score: 3,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB26");
  });

  it("rejects submit once a newer round in the same room has resolved (RFB27, window closed)", async () => {
    const [brewer, rater, other] = await Promise.all([
      signUp("brewrate-window-brewer"),
      signUp("brewrate-window-rater"),
      signUp("brewrate-window-other"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // A later round the rater didn't even participate in still closes the
    // window -- the rule is "any round in the room", not "any round the
    // rater was in" (that's the separate Most Recent Round rule, RFB26).
    await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, other.googleSub],
      resolvedAt: new Date(),
    });

    const { error } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 3,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB27");
  });

  it("withdraws the caller's own rating, deleting the row", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-withdraw-brewer"),
      signUp("brewrate-withdraw-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const { data: ratingId } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 3,
    });

    const { error } = await rater.client.rpc("withdraw_brew_rating", { p_round_id: roundId });
    expect(error).toBeNull();

    const { data: row } = await admin.from("brew_ratings").select("id").eq("id", ratingId).maybeSingle();
    expect(row).toBeNull();

    // A second submit after withdrawal is treated as fresh, not an edit.
    const { data: freshId, error: resubmitError } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 5,
    });
    expect(resubmitError).toBeNull();
    expect(freshId).not.toBe(ratingId);
  });

  it("is a no-op to withdraw a rating that was never submitted", async () => {
    const [brewer, rater] = await Promise.all([
      signUp("brewrate-withdraw-noop-brewer"),
      signUp("brewrate-withdraw-noop-rater"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(),
    });

    const { error } = await rater.client.rpc("withdraw_brew_rating", { p_round_id: roundId });
    expect(error).toBeNull();
  });

  it("rejects withdraw once the rating window has closed (RFB27)", async () => {
    const [brewer, rater, other] = await Promise.all([
      signUp("brewrate-withdraw-window-brewer"),
      signUp("brewrate-withdraw-window-rater"),
      signUp("brewrate-withdraw-window-other"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub],
      resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { data: ratingId } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 3,
    });
    expect(ratingId).toBeTruthy();

    await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, other.googleSub],
      resolvedAt: new Date(),
    });

    const { error } = await rater.client.rpc("withdraw_brew_rating", { p_round_id: roundId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB27");
  });

  it("RLS: a rater can read back their own row; a different player (including the brewer) cannot", async () => {
    const [brewer, rater, bystander] = await Promise.all([
      signUp("brewrate-rls-brewer"),
      signUp("brewrate-rls-rater"),
      signUp("brewrate-rls-bystander"),
    ]);

    const roundId = await seedResolvedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      brewerId: brewer.googleSub,
      participantIds: [brewer.googleSub, rater.googleSub, bystander.googleSub],
      resolvedAt: new Date(),
    });

    const { data: ratingId } = await rater.client.rpc("submit_brew_rating", {
      p_round_id: roundId,
      p_score: 4,
    });

    const { data: ownRow, error: ownError } = await rater.client
      .from("brew_ratings")
      .select("id, score")
      .eq("id", ratingId)
      .maybeSingle();
    expect(ownError).toBeNull();
    expect(ownRow?.score).toBe(4);

    const { data: brewerView } = await brewer.client
      .from("brew_ratings")
      .select("id")
      .eq("id", ratingId)
      .maybeSingle();
    expect(brewerView).toBeNull();

    const { data: bystanderView } = await bystander.client
      .from("brew_ratings")
      .select("id")
      .eq("id", ratingId)
      .maybeSingle();
    expect(bystanderView).toBeNull();
  });
});
