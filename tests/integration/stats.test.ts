import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Seeds resolved
// rounds directly via the admin client (bypassing RLS and the full
// roll/resolve RPC flow) so resolved_at can be pinned to known past
// instants — the only way to exercise the last-30-days window of the
// stats_* views (supabase/migrations/0006_stats_leaderboards.sql)
// deterministically. Reads happen through a signed-in anon client, the same
// as the app, to also prove the views are actually granted to authenticated.
describe.skipIf(!hasAnonTestEnv)("stats & leaderboard views", () => {
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
    cupsMade: number;
    resolvedAt: Date;
  }) {
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: options.roomId,
        started_by: options.startedBy,
        status: "resolved",
        brewer_id: options.brewerId,
        cups_made: options.cupsMade,
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

  // Seeds a modifier_adjustments row directly (bypassing log_modifier_adjustment)
  // so created_at can be pinned to a known instant, the same reason
  // seedResolvedRound bypasses resolve_round for resolved_at. Cleanup needs no
  // explicit tracking: both target_player_id and actor_player_id cascade
  // delete off players (0052), and cleanup always deletes the players a test
  // creates.
  async function seedAdjustment(options: {
    roomId: string;
    targetPlayerId: string;
    actorPlayerId: string;
    delta: number;
    reason: string;
    createdAt: Date;
  }) {
    const { data, error } = await admin
      .from("modifier_adjustments")
      .insert({
        room_id: options.roomId,
        target_player_id: options.targetPlayerId,
        actor_player_id: options.actorPlayerId,
        delta: options.delta,
        reason: options.reason,
        created_at: options.createdAt.toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;

    return data.id as string;
  }

  it("stats_cups_made_{all_time,last_30_days} sum a brewer's cups_made, filtered by resolved_at", async () => {
    const [a, b] = await Promise.all([signUp("cups-a"), signUp("cups-b")]);
    const now = new Date();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    await seedResolvedRound({
      roomId: a.roomId,
      startedBy: a.googleSub,
      brewerId: a.googleSub,
      participantIds: [a.googleSub, b.googleSub],
      cupsMade: 3,
      resolvedAt: now,
    });
    await seedResolvedRound({
      roomId: a.roomId,
      startedBy: a.googleSub,
      brewerId: a.googleSub,
      participantIds: [a.googleSub, b.googleSub],
      cupsMade: 1,
      resolvedAt: fortyDaysAgo,
    });
    await seedResolvedRound({
      roomId: a.roomId,
      startedBy: b.googleSub,
      brewerId: b.googleSub,
      participantIds: [a.googleSub, b.googleSub],
      cupsMade: 2,
      resolvedAt: now,
    });

    const { data: allTime, error: allTimeError } = await a.client
      .from("stats_cups_made_all_time")
      .select("player_id, cups_made")
      .in("player_id", [a.googleSub, b.googleSub]);
    expect(allTimeError).toBeNull();
    const allTimeById = Object.fromEntries((allTime ?? []).map((r) => [r.player_id, r.cups_made]));
    expect(allTimeById[a.googleSub]).toBe(4);
    expect(allTimeById[b.googleSub]).toBe(2);

    const { data: last30, error: last30Error } = await a.client
      .from("stats_cups_made_last_30_days")
      .select("player_id, cups_made")
      .in("player_id", [a.googleSub, b.googleSub]);
    expect(last30Error).toBeNull();
    const last30ById = Object.fromEntries((last30 ?? []).map((r) => [r.player_id, r.cups_made]));
    expect(last30ById[a.googleSub]).toBe(3);
    expect(last30ById[b.googleSub]).toBe(2);
  });

  it("stats_rounds_lost_{all_time,last_30_days} counts brewer occurrences, includes zero-loss participants, and filters by resolved_at", async () => {
    const [a, b] = await Promise.all([signUp("lost-a"), signUp("lost-b")]);
    const now = new Date();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    await seedResolvedRound({
      roomId: a.roomId,
      startedBy: a.googleSub,
      brewerId: a.googleSub,
      participantIds: [a.googleSub, b.googleSub],
      cupsMade: 2,
      resolvedAt: now,
    });
    await seedResolvedRound({
      roomId: a.roomId,
      startedBy: a.googleSub,
      brewerId: a.googleSub,
      participantIds: [a.googleSub, b.googleSub],
      cupsMade: 2,
      resolvedAt: fortyDaysAgo,
    });

    const { data: allTime, error: allTimeError } = await a.client
      .from("stats_rounds_lost_all_time")
      .select("player_id, rounds_lost")
      .in("player_id", [a.googleSub, b.googleSub]);
    expect(allTimeError).toBeNull();
    const allTimeById = Object.fromEntries((allTime ?? []).map((r) => [r.player_id, r.rounds_lost]));
    expect(allTimeById[a.googleSub]).toBe(2);
    expect(allTimeById[b.googleSub]).toBe(0);

    const { data: last30, error: last30Error } = await a.client
      .from("stats_rounds_lost_last_30_days")
      .select("player_id, rounds_lost")
      .in("player_id", [a.googleSub, b.googleSub]);
    expect(last30Error).toBeNull();
    const last30ById = Object.fromEntries((last30 ?? []).map((r) => [r.player_id, r.rounds_lost]));
    expect(last30ById[a.googleSub]).toBe(1);
    expect(last30ById[b.googleSub]).toBe(0);
  });

  it("stats_loss_percentage_{all_time,last_30_days} divides rounds_lost by rounds_played per player, filtered by resolved_at", async () => {
    const [a, b] = await Promise.all([signUp("pct-a"), signUp("pct-b")]);
    const now = new Date();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    await seedResolvedRound({
      roomId: a.roomId,
      startedBy: a.googleSub,
      brewerId: a.googleSub,
      participantIds: [a.googleSub, b.googleSub],
      cupsMade: 2,
      resolvedAt: now,
    });
    await seedResolvedRound({
      roomId: a.roomId,
      startedBy: a.googleSub,
      brewerId: a.googleSub,
      participantIds: [a.googleSub, b.googleSub],
      cupsMade: 2,
      resolvedAt: fortyDaysAgo,
    });

    const { data: allTime, error: allTimeError } = await a.client
      .from("stats_loss_percentage_all_time")
      .select("player_id, rounds_played, rounds_lost, loss_percentage")
      .in("player_id", [a.googleSub, b.googleSub]);
    expect(allTimeError).toBeNull();
    const allTimeById = Object.fromEntries((allTime ?? []).map((r) => [r.player_id, r]));
    expect(allTimeById[a.googleSub]).toMatchObject({
      rounds_played: 2,
      rounds_lost: 2,
      loss_percentage: 100,
    });
    expect(allTimeById[b.googleSub]).toMatchObject({
      rounds_played: 2,
      rounds_lost: 0,
      loss_percentage: 0,
    });

    const { data: last30, error: last30Error } = await a.client
      .from("stats_loss_percentage_last_30_days")
      .select("player_id, rounds_played, rounds_lost, loss_percentage")
      .in("player_id", [a.googleSub, b.googleSub]);
    expect(last30Error).toBeNull();
    const last30ById = Object.fromEntries((last30 ?? []).map((r) => [r.player_id, r]));
    expect(last30ById[a.googleSub]).toMatchObject({
      rounds_played: 1,
      rounds_lost: 1,
      loss_percentage: 100,
    });
    expect(last30ById[b.googleSub]).toMatchObject({
      rounds_played: 1,
      rounds_lost: 0,
      loss_percentage: 0,
    });
  });

  it("stats_modifier_peak_{all_time,last_30_days} is the running sum of a brewer's cups_made within one room, filtered by resolved_at", async () => {
    const [c, other] = await Promise.all([signUp("peak-c"), signUp("peak-other")]);
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date();

    await seedResolvedRound({
      roomId: c.roomId,
      startedBy: c.googleSub,
      brewerId: c.googleSub,
      participantIds: [c.googleSub, other.googleSub],
      cupsMade: 2,
      resolvedAt: fortyDaysAgo,
    });
    await seedResolvedRound({
      roomId: c.roomId,
      startedBy: c.googleSub,
      brewerId: c.googleSub,
      participantIds: [c.googleSub, other.googleSub],
      cupsMade: 3,
      resolvedAt: recent,
    });

    const { data: allTime, error: allTimeError } = await c.client
      .from("stats_modifier_peak_all_time")
      .select("player_id, peak_modifier")
      .eq("player_id", c.googleSub)
      .single();
    expect(allTimeError).toBeNull();
    expect(allTime!.peak_modifier).toBe(5);

    const { data: last30, error: last30Error } = await c.client
      .from("stats_modifier_peak_last_30_days")
      .select("player_id, peak_modifier")
      .eq("player_id", c.googleSub)
      .single();
    expect(last30Error).toBeNull();
    expect(last30!.peak_modifier).toBe(3);
  });

  it("stats_modifier_peak_{all_time,last_30_days} interleaves round losses and adjustments chronologically, not adjustments-on-top (issue #185)", async () => {
    const [c, other] = await Promise.all([
      signUp("peak-interleave-c"),
      signUp("peak-interleave-other"),
    ]);
    const t1 = new Date(Date.now() - 3 * 60 * 1000);
    const t2 = new Date(Date.now() - 2 * 60 * 1000);
    const t3 = new Date(Date.now() - 1 * 60 * 1000);

    // Chronological order: round loss (+3, running=3) -> adjustment (-5,
    // running=-2) -> round loss (+4, running=2). True peak is 3, reached at
    // t1. A naive "sum adjustments on top of the round-only peak" (or
    // "rounds only") approximation would instead compute the round-only
    // running sum (3, then 3+4=7) and report a peak of 7 — wrong, and at
    // the wrong point in time too.
    await seedResolvedRound({
      roomId: c.roomId,
      startedBy: c.googleSub,
      brewerId: c.googleSub,
      participantIds: [c.googleSub, other.googleSub],
      cupsMade: 3,
      resolvedAt: t1,
    });
    await seedAdjustment({
      roomId: c.roomId,
      targetPlayerId: c.googleSub,
      actorPlayerId: other.googleSub,
      delta: -5,
      reason: "test penalty",
      createdAt: t2,
    });
    await seedResolvedRound({
      roomId: c.roomId,
      startedBy: c.googleSub,
      brewerId: c.googleSub,
      participantIds: [c.googleSub, other.googleSub],
      cupsMade: 4,
      resolvedAt: t3,
    });

    const { data: allTime, error: allTimeError } = await c.client
      .from("stats_modifier_peak_all_time")
      .select("player_id, peak_modifier")
      .eq("player_id", c.googleSub)
      .single();
    expect(allTimeError).toBeNull();
    expect(allTime!.peak_modifier).toBe(3);

    const { data: last30, error: last30Error } = await c.client
      .from("stats_modifier_peak_last_30_days")
      .select("player_id, peak_modifier")
      .eq("player_id", c.googleSub)
      .single();
    expect(last30Error).toBeNull();
    expect(last30!.peak_modifier).toBe(3);
  });

  it("stats_modifier_peak_last_30_days filters round losses and adjustments independently by their own timestamp", async () => {
    const [c, other] = await Promise.all([signUp("peak-filter-c"), signUp("peak-filter-other")]);
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date();

    // Round loss is stale (outside the 30-day window); adjustment is
    // recent. all_time sees both (running sum 2, then 2+5=7, peak 7);
    // last_30_days should see only the adjustment (peak 5), proving each
    // stream is filtered by its own timestamp column rather than the union
    // being filtered as a whole after the fact.
    await seedResolvedRound({
      roomId: c.roomId,
      startedBy: c.googleSub,
      brewerId: c.googleSub,
      participantIds: [c.googleSub, other.googleSub],
      cupsMade: 2,
      resolvedAt: fortyDaysAgo,
    });
    await seedAdjustment({
      roomId: c.roomId,
      targetPlayerId: c.googleSub,
      actorPlayerId: other.googleSub,
      delta: 5,
      reason: "coffee run",
      createdAt: recent,
    });

    const { data: allTime, error: allTimeError } = await c.client
      .from("stats_modifier_peak_all_time")
      .select("player_id, peak_modifier")
      .eq("player_id", c.googleSub)
      .single();
    expect(allTimeError).toBeNull();
    expect(allTime!.peak_modifier).toBe(7);

    const { data: last30, error: last30Error } = await c.client
      .from("stats_modifier_peak_last_30_days")
      .select("player_id, peak_modifier")
      .eq("player_id", c.googleSub)
      .single();
    expect(last30Error).toBeNull();
    expect(last30!.peak_modifier).toBe(5);
  });

  it("stats_room_adjustments exposes a room's adjustments (actor, target, delta, reason, timestamp)", async () => {
    const [a, b] = await Promise.all([signUp("room-adj-a"), signUp("room-adj-b")]);
    const createdAt = new Date();

    const adjustmentId = await seedAdjustment({
      roomId: a.roomId,
      targetPlayerId: b.googleSub,
      actorPlayerId: a.googleSub,
      delta: 10,
      reason: "muffin breakfast",
      createdAt,
    });

    const { data, error } = await a.client
      .from("stats_room_adjustments")
      .select(
        "room_id, adjustment_id, delta, reason, actor_id, target_id, created_at",
      )
      .eq("room_id", a.roomId)
      .eq("adjustment_id", adjustmentId)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      room_id: a.roomId,
      adjustment_id: adjustmentId,
      delta: 10,
      reason: "muffin breakfast",
      actor_id: a.googleSub,
      target_id: b.googleSub,
    });
    expect(new Date(data!.created_at as string).getTime()).toBe(createdAt.getTime());
  });

  it("stats_room_history and stats_room_rounds expose per-room resolved-round drill-down", async () => {
    const [a, b] = await Promise.all([signUp("room-a"), signUp("room-b")]);
    const now = new Date();

    const roundId = await seedResolvedRound({
      roomId: a.roomId,
      startedBy: a.googleSub,
      brewerId: b.googleSub,
      participantIds: [a.googleSub, b.googleSub],
      cupsMade: 2,
      resolvedAt: now,
    });

    const { data: history, error: historyError } = await a.client
      .from("stats_room_history")
      .select("room_id, resolved_round_count")
      .eq("room_id", a.roomId)
      .single();
    expect(historyError).toBeNull();
    expect(history!.resolved_round_count).toBeGreaterThanOrEqual(1);

    const { data: rounds, error: roundsError } = await a.client
      .from("stats_room_rounds")
      .select("round_id, starter_id, brewer_id, cups_made")
      .eq("room_id", a.roomId)
      .eq("round_id", roundId)
      .single();
    expect(roundsError).toBeNull();
    expect(rounds).toMatchObject({
      round_id: roundId,
      starter_id: a.googleSub,
      brewer_id: b.googleSub,
      cups_made: 2,
    });
  });
});
