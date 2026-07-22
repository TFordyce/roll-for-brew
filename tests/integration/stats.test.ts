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

  it("stats_cups_made_{all_time,last_30_days} sum a brewer's cups_made, filtered by resolved_at", async () => {
    const a = await signUp("cups-a");
    const b = await signUp("cups-b");
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
    const a = await signUp("lost-a");
    const b = await signUp("lost-b");
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
    const a = await signUp("pct-a");
    const b = await signUp("pct-b");
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
    const c = await signUp("peak-c");
    const other = await signUp("peak-other");
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

  it("stats_room_history and stats_room_rounds expose per-room resolved-round drill-down", async () => {
    const a = await signUp("room-a");
    const b = await signUp("room-b");
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
