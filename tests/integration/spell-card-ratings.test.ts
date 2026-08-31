import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// spell_card_ratings table and the rate_spell_card / withdraw_spell_card_rating
// RPCs added in supabase/migrations/0073_spell_card_ratings.sql (issue #300),
// plus get_player_spell_collection's new my_rating / is_cast_eligible columns.
//
// Seeds rounds and casts directly via the admin client (bypassing RLS and
// the full roll/resolve/cast RPC flow), the same approach brew-ratings.test.ts
// uses — eligibility here hinges only on a cast row's negated flag, its
// round's status, and its room's is_test flag.
describe.skipIf(!hasAnonTestEnv)("spell card ratings: rate, withdraw, eligibility", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;
  let cardA: { instanceId: string; cardId: string };
  let cardB: { instanceId: string; cardId: string };

  beforeAll(async () => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);

    // Two in-deck instances of two distinct catalog cards — a cast just
    // needs a card_instance_id to chain sdi -> spell_cards; its location is
    // never touched here.
    const { data: instances, error } = await admin
      .from("spell_deck_instances")
      .select("id, card_id")
      .limit(500);
    if (error) throw error;
    const byCard = new Map<string, string>();
    for (const row of instances as { id: string; card_id: string }[]) {
      if (!byCard.has(row.card_id)) byCard.set(row.card_id, row.id);
    }
    const distinct = [...byCard.entries()];
    expect(distinct.length).toBeGreaterThanOrEqual(2);
    cardA = { cardId: distinct[0]![0], instanceId: distinct[0]![1] };
    cardB = { cardId: distinct[1]![0], instanceId: distinct[1]![1] };
  });

  afterEach(() => cleanup.run());

  function signUp(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }

  async function seedTestRoom(): Promise<string> {
    const { data, error } = await admin
      .from("rooms")
      .insert({ date: "2020-01-01", is_test: true })
      .select("id")
      .single();
    if (error) throw error;
    const roomId = data.id as string;
    cleanup.trackRoom(roomId);
    return roomId;
  }

  async function seedRound(options: {
    roomId: string;
    startedBy: string;
    status: "open" | "resolved";
    participantIds: string[];
  }): Promise<string> {
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: options.roomId,
        started_by: options.startedBy,
        status: options.status,
        brewer_id: options.status === "resolved" ? options.startedBy : null,
        cups_made: options.status === "resolved" ? 1 : null,
        resolved_at: options.status === "resolved" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (error) throw error;
    const roundId = data.id as string;
    cleanup.trackRound(roundId);

    const { error: partError } = await admin
      .from("round_participants")
      .insert(options.participantIds.map((playerId) => ({ round_id: roundId, player_id: playerId })));
    if (partError) throw partError;

    return roundId;
  }

  async function seedCast(options: {
    roundId: string;
    casterId: string;
    instanceId: string;
    negated?: boolean;
  }): Promise<string> {
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: options.roundId,
        caster_id: options.casterId,
        card_instance_id: options.instanceId,
        negated: options.negated ?? false,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id as string;
  }

  it("rates a card the caller has a non-negated cast of, in a resolved non-test round", async () => {
    const rater = await signUp("spellrate-ok");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });

    const { data: ratingId, error } = await rater.client.rpc("rate_spell_card", {
      p_card_id: cardA.cardId,
      p_score: 4,
    });
    expect(error).toBeNull();
    expect(ratingId).toBeTruthy();

    const { data: row } = await admin
      .from("spell_card_ratings")
      .select("card_id, rater_player_id, score")
      .eq("id", ratingId)
      .single();
    expect(row).toEqual({ card_id: cardA.cardId, rater_player_id: rater.googleSub, score: 4 });
  });

  it("edits the same row on a second rate for the same card (upsert, no duplicate)", async () => {
    const rater = await signUp("spellrate-upsert");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });

    const { data: firstId } = await rater.client.rpc("rate_spell_card", {
      p_card_id: cardA.cardId,
      p_score: 2,
    });
    const { data: secondId, error } = await rater.client.rpc("rate_spell_card", {
      p_card_id: cardA.cardId,
      p_score: 5,
    });
    expect(error).toBeNull();
    expect(secondId).toBe(firstId);

    const { data: rows } = await admin
      .from("spell_card_ratings")
      .select("id, score")
      .eq("card_id", cardA.cardId)
      .eq("rater_player_id", rater.googleSub);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.score).toBe(5);
  });

  it("withdraws the caller's own rating, hard-deleting the row", async () => {
    const rater = await signUp("spellrate-withdraw");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });

    const { data: ratingId } = await rater.client.rpc("rate_spell_card", {
      p_card_id: cardA.cardId,
      p_score: 3,
    });

    const { error } = await rater.client.rpc("withdraw_spell_card_rating", { p_card_id: cardA.cardId });
    expect(error).toBeNull();

    const { data: gone } = await admin
      .from("spell_card_ratings")
      .select("id")
      .eq("id", ratingId)
      .maybeSingle();
    expect(gone).toBeNull();

    const { data: freshId, error: reRateError } = await rater.client.rpc("rate_spell_card", {
      p_card_id: cardA.cardId,
      p_score: 1,
    });
    expect(reRateError).toBeNull();
    expect(freshId).not.toBe(ratingId);
  });

  it("is a no-op to withdraw a rating that was never submitted", async () => {
    const rater = await signUp("spellrate-withdraw-noop");
    const { error } = await rater.client.rpc("withdraw_spell_card_rating", { p_card_id: cardA.cardId });
    expect(error).toBeNull();
  });

  it("rejects a score outside 1-5 (RFB41)", async () => {
    const rater = await signUp("spellrate-range");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });

    const { error } = await rater.client.rpc("rate_spell_card", { p_card_id: cardA.cardId, p_score: 6 });
    expect(error?.code).toBe("RFB41");
  });

  it("rejects a card that does not exist (RFB42)", async () => {
    const rater = await signUp("spellrate-nocard");
    const { error } = await rater.client.rpc("rate_spell_card", {
      p_card_id: "00000000-0000-0000-0000-000000000000",
      p_score: 3,
    });
    expect(error?.code).toBe("RFB42");
  });

  it("rejects rating a card the caller has never cast (RFB43)", async () => {
    const rater = await signUp("spellrate-nocast");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    // A cast of a *different* card — cardB — must not make cardA rateable.
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardB.instanceId });

    const { error } = await rater.client.rpc("rate_spell_card", { p_card_id: cardA.cardId, p_score: 3 });
    expect(error?.code).toBe("RFB43");
  });

  it("rejects rating a card only cast in a negated cast (RFB43)", async () => {
    const rater = await signUp("spellrate-negated");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId, negated: true });

    const { error } = await rater.client.rpc("rate_spell_card", { p_card_id: cardA.cardId, p_score: 3 });
    expect(error?.code).toBe("RFB43");
  });

  it("rejects rating a card only cast in an unresolved round (RFB43)", async () => {
    const rater = await signUp("spellrate-unresolved");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "open",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });

    const { error } = await rater.client.rpc("rate_spell_card", { p_card_id: cardA.cardId, p_score: 3 });
    expect(error?.code).toBe("RFB43");
  });

  it("rejects rating a card only cast in a test room (RFB43)", async () => {
    const rater = await signUp("spellrate-testroom");
    const testRoomId = await seedTestRoom();
    const roundId = await seedRound({
      roomId: testRoomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });

    const { error } = await rater.client.rpc("rate_spell_card", { p_card_id: cardA.cardId, p_score: 3 });
    expect(error?.code).toBe("RFB43");
  });

  it("get_player_spell_collection returns my_rating and is_cast_eligible per card", async () => {
    const rater = await signUp("spellrate-collection");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });
    await rater.client.rpc("rate_spell_card", { p_card_id: cardA.cardId, p_score: 5 });

    const { data, error } = await rater.client.rpc("get_player_spell_collection", {
      p_player_id: rater.googleSub,
    });
    expect(error).toBeNull();

    const rows = data as { card_id: string; my_rating: number | null; is_cast_eligible: boolean }[];
    const rated = rows.find((r) => r.card_id === cardA.cardId)!;
    expect(rated.my_rating).toBe(5);
    expect(rated.is_cast_eligible).toBe(true);

    const other = rows.find((r) => r.card_id === cardB.cardId)!;
    expect(other.my_rating).toBeNull();
    expect(other.is_cast_eligible).toBe(false);
  });

  it("get_player_spell_collection never exposes another player's rating or cast-eligibility", async () => {
    const [owner, viewer] = await Promise.all([
      signUp("spellrate-cross-owner"),
      signUp("spellrate-cross-viewer"),
    ]);
    const roundId = await seedRound({
      roomId: owner.roomId,
      startedBy: owner.googleSub,
      status: "resolved",
      participantIds: [owner.googleSub],
    });
    await seedCast({ roundId, casterId: owner.googleSub, instanceId: cardA.instanceId });
    await owner.client.rpc("rate_spell_card", { p_card_id: cardA.cardId, p_score: 5 });

    // The viewer loads the owner's collection — my_rating / is_cast_eligible
    // are scoped to the caller server-side, so the owner's score and cast
    // history must not appear in the payload at all.
    const { data, error } = await viewer.client.rpc("get_player_spell_collection", {
      p_player_id: owner.googleSub,
    });
    expect(error).toBeNull();

    const rows = data as { card_id: string; my_rating: number | null; is_cast_eligible: boolean }[];
    const rated = rows.find((r) => r.card_id === cardA.cardId)!;
    expect(rated.my_rating).toBeNull();
    expect(rated.is_cast_eligible).toBe(false);
  });

  it("a rating survives deletion of the round its qualifying cast belonged to; eligibility flips off", async () => {
    const rater = await signUp("spellrate-round-deleted");
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });
    const { data: ratingId } = await rater.client.rpc("rate_spell_card", {
      p_card_id: cardA.cardId,
      p_score: 4,
    });
    expect(ratingId).toBeTruthy();

    // Deleting the round cascades its spell_casts away (0019) — the rating
    // row must persist regardless.
    await admin.from("rounds").delete().eq("id", roundId);

    const { data: stillThere } = await admin
      .from("spell_card_ratings")
      .select("score")
      .eq("id", ratingId)
      .single();
    expect(stillThere?.score).toBe(4);

    const { data } = await rater.client.rpc("get_player_spell_collection", {
      p_player_id: rater.googleSub,
    });
    const rows = data as { card_id: string; my_rating: number | null; is_cast_eligible: boolean }[];
    const rated = rows.find((r) => r.card_id === cardA.cardId)!;
    expect(rated.my_rating).toBe(4);
    expect(rated.is_cast_eligible).toBe(false);
  });

  it("RLS: a rater reads back their own row; a different player cannot", async () => {
    const [rater, bystander] = await Promise.all([
      signUp("spellrate-rls-rater"),
      signUp("spellrate-rls-bystander"),
    ]);
    const roundId = await seedRound({
      roomId: rater.roomId,
      startedBy: rater.googleSub,
      status: "resolved",
      participantIds: [rater.googleSub],
    });
    await seedCast({ roundId, casterId: rater.googleSub, instanceId: cardA.instanceId });

    const { data: ratingId } = await rater.client.rpc("rate_spell_card", {
      p_card_id: cardA.cardId,
      p_score: 4,
    });

    const { data: ownRow, error: ownError } = await rater.client
      .from("spell_card_ratings")
      .select("id, score")
      .eq("id", ratingId)
      .maybeSingle();
    expect(ownError).toBeNull();
    expect(ownRow?.score).toBe(4);

    const { data: bystanderView } = await bystander.client
      .from("spell_card_ratings")
      .select("id")
      .eq("id", ratingId)
      .maybeSingle();
    expect(bystanderView).toBeNull();
  });
});
