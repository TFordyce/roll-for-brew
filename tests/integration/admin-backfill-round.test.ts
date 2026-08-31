import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the Round
// Backfill tool (0072_admin_backfill_round.sql, issue #274) — admin_backfill_round
// — through real signed-in sessions.
describe.skipIf(!hasAnonTestEnv)("admin_backfill_round: bulk-records an entire missed round", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  function signUpSignInAndEnter(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }

  async function makeAdmin(playerId: string) {
    const { error } = await admin.from("players").update({ is_admin: true }).eq("id", playerId);
    if (error) throw error;
  }

  type BackfillEntry = { player_id: string; value: number };

  async function backfill(client: SupabaseClient, participantIds: string[], layers: BackfillEntry[][]) {
    return client.rpc("admin_backfill_round", { p_participant_ids: participantIds, p_layers: layers });
  }

  it("rejects a non-admin caller (RFB33)", async () => {
    const [a, b] = await Promise.all([
      signUpSignInAndEnter("backfill-not-admin-a"),
      signUpSignInAndEnter("backfill-not-admin-b"),
    ]);

    const { data, error } = await backfill(a.client, [a.googleSub, b.googleSub], [
      [
        { player_id: a.googleSub, value: 5 },
        { player_id: b.googleSub, value: 12 },
      ],
    ]);
    expect(data).toBeNull();
    expect(error?.code).toBe("RFB33");
  });

  it("rejects fewer than 2 participants (RFB34)", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("backfill-too-few");
    await makeAdmin(googleSub);

    const { error } = await backfill(client, [googleSub], [[{ player_id: googleSub, value: 5 }]]);
    expect(error?.code).toBe("RFB34");
  });

  it("rejects zero layers (RFB35)", async () => {
    const [a, b] = await Promise.all([
      signUpSignInAndEnter("backfill-no-layers-a"),
      signUpSignInAndEnter("backfill-no-layers-b"),
    ]);
    await makeAdmin(a.googleSub);

    const { error } = await backfill(a.client, [a.googleSub, b.googleSub], []);
    expect(error?.code).toBe("RFB35");
  });

  it("rejects backfilling while another round is already live in today's room (RFB36)", async () => {
    const [a, b] = await Promise.all([
      signUpSignInAndEnter("backfill-already-live-a"),
      signUpSignInAndEnter("backfill-already-live-b"),
    ]);
    await makeAdmin(a.googleSub);

    const { data: liveRoundId, error: startError } = await a.client.rpc("start_round", { p_room_id: null });
    if (startError) throw startError;
    cleanup.trackRound(liveRoundId as string);

    const { error } = await backfill(a.client, [a.googleSub, b.googleSub], [
      [
        { player_id: a.googleSub, value: 5 },
        { player_id: b.googleSub, value: 12 },
      ],
    ]);
    expect(error?.code).toBe("RFB36");
  });

  it("rejects a layer whose roster doesn't match the expected tied set (RFB37)", async () => {
    const [a, b, c] = await Promise.all([
      signUpSignInAndEnter("backfill-roster-mismatch-a"),
      signUpSignInAndEnter("backfill-roster-mismatch-b"),
      signUpSignInAndEnter("backfill-roster-mismatch-c"),
    ]);
    await makeAdmin(a.googleSub);

    // Only 2 of the 3 declared participants get a layer-0 roll.
    const { error } = await backfill(a.client, [a.googleSub, b.googleSub, c.googleSub], [
      [
        { player_id: a.googleSub, value: 5 },
        { player_id: b.googleSub, value: 12 },
      ],
    ]);
    expect(error?.code).toBe("RFB37");
  });

  it("rejects an out-of-range roll value (RFB38)", async () => {
    const [a, b] = await Promise.all([
      signUpSignInAndEnter("backfill-out-of-range-a"),
      signUpSignInAndEnter("backfill-out-of-range-b"),
    ]);
    await makeAdmin(a.googleSub);

    const { error } = await backfill(a.client, [a.googleSub, b.googleSub], [
      [
        { player_id: a.googleSub, value: 21 },
        { player_id: b.googleSub, value: 12 },
      ],
    ]);
    expect(error?.code).toBe("RFB38");
  });

  it("rejects supplying an extra layer once the round already resolved (RFB39)", async () => {
    const [a, b] = await Promise.all([
      signUpSignInAndEnter("backfill-extra-layer-a"),
      signUpSignInAndEnter("backfill-extra-layer-b"),
    ]);
    await makeAdmin(a.googleSub);

    const { error } = await backfill(a.client, [a.googleSub, b.googleSub], [
      [
        { player_id: a.googleSub, value: 5 },
        { player_id: b.googleSub, value: 12 },
      ],
      [
        { player_id: a.googleSub, value: 8 },
        { player_id: b.googleSub, value: 9 },
      ],
    ]);
    expect(error?.code).toBe("RFB39");
  });

  it("rejects a still-tied final layer with no further layer supplied (RFB40)", async () => {
    const [a, b] = await Promise.all([
      signUpSignInAndEnter("backfill-still-tied-a"),
      signUpSignInAndEnter("backfill-still-tied-b"),
    ]);
    await makeAdmin(a.googleSub);

    // Both roll 10 with 0 modifier — a tie, but only one layer was given.
    const { error } = await backfill(a.client, [a.googleSub, b.googleSub], [
      [
        { player_id: a.googleSub, value: 10 },
        { player_id: b.googleSub, value: 10 },
      ],
    ]);
    expect(error?.code).toBe("RFB40");
  });

  it("resolves a straightforward two-player round with no tie, flagging provenance throughout", async () => {
    const [adminSession, a, b] = await Promise.all([
      signUpSignInAndEnter("backfill-happy-admin"),
      signUpSignInAndEnter("backfill-happy-a"),
      signUpSignInAndEnter("backfill-happy-b"),
    ]);
    await makeAdmin(adminSession.googleSub);

    // a's total (5) < b's total (12) — a is the brewer.
    const { data: roundId, error } = await backfill(adminSession.client, [a.googleSub, b.googleSub], [
      [
        { player_id: a.googleSub, value: 5 },
        { player_id: b.googleSub, value: 12 },
      ],
    ]);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);

    const { data: round } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made, current_layer, backfilled_by")
      .eq("id", roundId)
      .single();
    expect(round).toEqual({
      status: "resolved",
      brewer_id: a.googleSub,
      cups_made: 2,
      current_layer: 0,
      backfilled_by: adminSession.googleSub,
    });

    const { data: rolls } = await admin
      .from("rolls")
      .select("player_id, layer, value, input_mode, entered_by_admin")
      .eq("round_id", roundId)
      .order("player_id");
    expect(rolls).toEqual(
      [
        { player_id: a.googleSub, layer: 0, value: 5, input_mode: "manual", entered_by_admin: true },
        { player_id: b.googleSub, layer: 0, value: 12, input_mode: "manual", entered_by_admin: true },
      ].sort((x, y) => x.player_id.localeCompare(y.player_id)),
    );

    // Brewer's modifier was bumped by cups_made, same as any live round.
    const { data: brewerRoomPlayer } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", a.roomId)
      .eq("player_id", a.googleSub)
      .single();
    expect(brewerRoomPlayer?.modifier).toBe(2);
  });

  it("implicitly creates room_players rows for participants who never logged in today", async () => {
    const adminSession = await signUpSignInAndEnter("backfill-implicit-membership-admin");
    await makeAdmin(adminSession.googleSub);

    // Create two bare player rows directly, bypassing enter_todays_room
    // entirely — modelling "nobody at all opened the app that day".
    const notLoggedInA = `google-sub-backfill-nli-a-${Date.now()}`;
    const notLoggedInB = `google-sub-backfill-nli-b-${Date.now()}`;
    cleanup.trackPlayerId(notLoggedInA);
    cleanup.trackPlayerId(notLoggedInB);
    await admin.from("players").insert([
      { id: notLoggedInA, email: `${notLoggedInA}@example.com`, display_name: "Not Logged In A", is_test: false },
      { id: notLoggedInB, email: `${notLoggedInB}@example.com`, display_name: "Not Logged In B", is_test: false },
    ]);

    const { data: roundId, error } = await backfill(adminSession.client, [notLoggedInA, notLoggedInB], [
      [
        { player_id: notLoggedInA, value: 3 },
        { player_id: notLoggedInB, value: 18 },
      ],
    ]);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);

    const { data: roomPlayers } = await admin
      .from("room_players")
      .select("player_id")
      .eq("room_id", adminSession.roomId)
      .in("player_id", [notLoggedInA, notLoggedInB]);
    expect((roomPlayers ?? []).map((r) => r.player_id).sort()).toEqual([notLoggedInA, notLoggedInB].sort());
  });

  it("resolves a round that ties at layer 0 and is decided by a layer-1 reroll", async () => {
    const [adminSession, a, b, c] = await Promise.all([
      signUpSignInAndEnter("backfill-tie-admin"),
      signUpSignInAndEnter("backfill-tie-a"),
      signUpSignInAndEnter("backfill-tie-b"),
      signUpSignInAndEnter("backfill-tie-c"),
    ]);
    await makeAdmin(adminSession.googleSub);

    // Layer 0: a and b both roll 10 (tied, lowest); c rolls 15 (out).
    // Layer 1: a rerolls 6, b rerolls 14 — a is the brewer.
    const { data: roundId, error } = await backfill(
      adminSession.client,
      [a.googleSub, b.googleSub, c.googleSub],
      [
        [
          { player_id: a.googleSub, value: 10 },
          { player_id: b.googleSub, value: 10 },
          { player_id: c.googleSub, value: 15 },
        ],
        [
          { player_id: a.googleSub, value: 6 },
          { player_id: b.googleSub, value: 14 },
        ],
      ],
    );
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);

    const { data: round } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made, current_layer")
      .eq("id", roundId)
      .single();
    expect(round).toEqual({ status: "resolved", brewer_id: a.googleSub, cups_made: 3, current_layer: 1 });

    const { data: layerParticipants } = await admin
      .from("round_layer_participants")
      .select("player_id")
      .eq("round_id", roundId)
      .eq("layer", 1);
    expect((layerParticipants ?? []).map((r) => r.player_id).sort()).toEqual([a.googleSub, b.googleSub].sort());

    const { data: layer1Rolls } = await admin
      .from("rolls")
      .select("player_id, value")
      .eq("round_id", roundId)
      .eq("layer", 1)
      .order("player_id");
    expect(layer1Rolls).toEqual(
      [
        { player_id: a.googleSub, value: 6 },
        { player_id: b.googleSub, value: 14 },
      ].sort((x, y) => x.player_id.localeCompare(y.player_id)),
    );
  });
});
