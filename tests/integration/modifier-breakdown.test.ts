import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises
// get_modifier_breakdown added in supabase/migrations/0054_modifier_breakdown.sql
// (issue #184, part of #182).
describe.skipIf(!hasAnonTestEnv)("get_modifier_breakdown", () => {
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

  // Inserts an already-resolved round directly (admin bypasses RLS) rather
  // than driving the full start/declare/roll/resolve flow — this suite only
  // needs a resolved round's cups_made to exist and be summable, not the
  // resolution engine itself (covered by roll-and-resolve.test.ts). Tracked
  // individually (rather than via trackRoom) since it's created against
  // today's shared room, which other tests/real usage also share.
  async function insertResolvedRound(roomId: string, brewerId: string, cupsMade: number) {
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: roomId,
        started_by: brewerId,
        status: "resolved",
        brewer_id: brewerId,
        cups_made: cupsMade,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    cleanup.trackRound(data!.id);
  }

  it("returns zero for both sums when a player has no history of either kind", async () => {
    const player = await signUp("modbreak-zero");

    const { data, error } = await player.client.rpc("get_modifier_breakdown", {
      p_player_id: player.googleSub,
      p_room_id: player.roomId,
    });
    expect(error).toBeNull();
    expect(data).toEqual([{ cups_made: 0, adjustments: 0 }]);
  });

  it("sums resolved-round cups_made as brewer, in that room", async () => {
    const player = await signUp("modbreak-cups");

    await insertResolvedRound(player.roomId, player.googleSub, 2);
    await insertResolvedRound(player.roomId, player.googleSub, 3);

    const { data, error } = await player.client.rpc("get_modifier_breakdown", {
      p_player_id: player.googleSub,
      p_room_id: player.roomId,
    });
    expect(error).toBeNull();
    expect(data).toEqual([{ cups_made: 5, adjustments: 0 }]);
  });

  it("sums modifier_adjustments.delta, in that room", async () => {
    const [actor, target] = await Promise.all([
      signUp("modbreak-adj-actor"),
      signUp("modbreak-adj-target"),
    ]);

    const { error: firstError } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 4,
      p_reason: "first",
    });
    expect(firstError).toBeNull();
    const { error: secondError } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: -1,
      p_reason: "second",
    });
    expect(secondError).toBeNull();

    const { data, error } = await target.client.rpc("get_modifier_breakdown", {
      p_player_id: target.googleSub,
      p_room_id: target.roomId,
    });
    expect(error).toBeNull();
    expect(data).toEqual([{ cups_made: 0, adjustments: 3 }]);
  });

  it("sums both kinds together when both exist", async () => {
    const [actor, target] = await Promise.all([
      signUp("modbreak-both-actor"),
      signUp("modbreak-both-target"),
    ]);

    await insertResolvedRound(target.roomId, target.googleSub, 4);
    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 2,
      p_reason: "bonus",
    });
    expect(error).toBeNull();

    const { data, error: breakdownError } = await target.client.rpc("get_modifier_breakdown", {
      p_player_id: target.googleSub,
      p_room_id: target.roomId,
    });
    expect(breakdownError).toBeNull();
    expect(data).toEqual([{ cups_made: 4, adjustments: 2 }]);
  });

  it("scopes sums to the given room, excluding other rooms' history", async () => {
    const player = await signUp("modbreak-scope");

    // A second, explicit room (today's shared room is the same for every
    // signUp above) holding the player's cups/adjustments — querying
    // today's room for them should see none of it.
    const { data: otherRoom, error: roomError } = await admin
      .from("rooms")
      .insert({ date: "2020-03-03" })
      .select("id")
      .single();
    expect(roomError).toBeNull();
    cleanup.trackRoom(otherRoom!.id);

    await insertResolvedRound(otherRoom!.id, player.googleSub, 6);
    const { error: adjError } = await admin.from("modifier_adjustments").insert({
      room_id: otherRoom!.id,
      target_player_id: player.googleSub,
      actor_player_id: player.googleSub,
      delta: 5,
      reason: "wrong room",
    });
    expect(adjError).toBeNull();

    const { data, error } = await player.client.rpc("get_modifier_breakdown", {
      p_player_id: player.googleSub,
      p_room_id: player.roomId,
    });
    expect(error).toBeNull();
    expect(data).toEqual([{ cups_made: 0, adjustments: 0 }]);
  });
});
