import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises
// usual_drinks, orders, submit_order, and round_menu, all added in
// supabase/migrations/0062_usual_order_menu.sql (issue #224, part of #223).
describe.skipIf(!hasAnonTestEnv)("usual_drinks", () => {
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

  it("upserts and reads back the caller's own Usual row directly under RLS", async () => {
    const player = await signUp("usual-own-row");

    const { error: insertError } = await player.client
      .from("usual_drinks")
      .insert({ player_id: player.googleSub, drink_type: "tea", milk: "Oat", sugar: "1 Tsp" });
    expect(insertError).toBeNull();

    const { data: row, error: readError } = await player.client
      .from("usual_drinks")
      .select("milk, sugar, decaf")
      .eq("player_id", player.googleSub)
      .eq("drink_type", "tea")
      .single();
    expect(readError).toBeNull();
    // decaf defaults false when omitted from the insert (0063_usual_drinks_decaf.sql).
    expect(row).toEqual({ milk: "Oat", sugar: "1 Tsp", decaf: false });

    const { error: updateError } = await player.client
      .from("usual_drinks")
      .update({ milk: "Dairy", sugar: "None", decaf: true })
      .eq("player_id", player.googleSub)
      .eq("drink_type", "tea");
    expect(updateError).toBeNull();

    const { data: updatedRow } = await player.client
      .from("usual_drinks")
      .select("milk, sugar, decaf")
      .eq("player_id", player.googleSub)
      .eq("drink_type", "tea")
      .single();
    expect(updatedRow).toEqual({ milk: "Dairy", sugar: "None", decaf: true });
  });

  it("tea and coffee Usuals are independent rows for the same player, including decaf", async () => {
    const player = await signUp("usual-independent");

    await player.client
      .from("usual_drinks")
      .insert({ player_id: player.googleSub, drink_type: "tea", milk: "Dairy", sugar: "1 Tsp", decaf: true });
    await player.client
      .from("usual_drinks")
      .insert({ player_id: player.googleSub, drink_type: "coffee", milk: "Soy", sugar: "None", decaf: false });

    const { data: rows } = await player.client
      .from("usual_drinks")
      .select("drink_type, milk, sugar, decaf")
      .eq("player_id", player.googleSub)
      .order("drink_type", { ascending: true });
    expect(rows).toEqual([
      { drink_type: "coffee", milk: "Soy", sugar: "None", decaf: false },
      { drink_type: "tea", milk: "Dairy", sugar: "1 Tsp", decaf: true },
    ]);
  });

  it("is world-readable: a different player can read the row, but not write it (RLS)", async () => {
    const owner = await signUp("usual-rls-owner");
    const other = await signUp("usual-rls-other");

    await owner.client
      .from("usual_drinks")
      .insert({ player_id: owner.googleSub, drink_type: "tea", milk: "Oat", sugar: "Sprinkle" });

    const { data: readRow, error: readError } = await other.client
      .from("usual_drinks")
      .select("milk, sugar")
      .eq("player_id", owner.googleSub)
      .eq("drink_type", "tea")
      .single();
    expect(readError).toBeNull();
    expect(readRow).toEqual({ milk: "Oat", sugar: "Sprinkle" });

    const { error: writeError } = await other.client
      .from("usual_drinks")
      .update({ milk: "None", sugar: "None" })
      .eq("player_id", owner.googleSub)
      .eq("drink_type", "tea");
    // RLS silently matches zero rows rather than raising -- confirm the
    // owner's row is untouched instead of asserting on writeError alone.
    expect(writeError).toBeNull();

    const { data: unchangedRow } = await admin
      .from("usual_drinks")
      .select("milk, sugar")
      .eq("player_id", owner.googleSub)
      .eq("drink_type", "tea")
      .single();
    expect(unchangedRow).toEqual({ milk: "Oat", sugar: "Sprinkle" });

    const { error: insertAsOtherError } = await other.client
      .from("usual_drinks")
      .insert({ player_id: owner.googleSub, drink_type: "coffee", milk: "Dairy", sugar: "None" });
    expect(insertAsOtherError).not.toBeNull();
  });

  it("rejects an invalid milk/sugar enum value", async () => {
    const player = await signUp("usual-invalid-enum");

    const { error: milkError } = await player.client
      .from("usual_drinks")
      .insert({ player_id: player.googleSub, drink_type: "tea", milk: "Almond", sugar: "None" });
    expect(milkError).not.toBeNull();

    const { error: sugarError } = await player.client
      .from("usual_drinks")
      .insert({ player_id: player.googleSub, drink_type: "tea", milk: "Dairy", sugar: "Extra Sweet" });
    expect(sugarError).not.toBeNull();

    const { error: drinkTypeError } = await player.client
      .from("usual_drinks")
      .insert({ player_id: player.googleSub, drink_type: "juice", milk: "Dairy", sugar: "None" });
    expect(drinkTypeError).not.toBeNull();
  });
});

describe.skipIf(!hasAnonTestEnv)("submit_order", () => {
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

  async function seedRound(options: {
    roomId: string;
    startedBy: string;
    status: "open" | "closed" | "resolved" | "cancelled";
    startedAt: Date;
    resolvedAt?: Date;
    brewerId?: string;
  }) {
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: options.roomId,
        started_by: options.startedBy,
        status: options.status,
        started_at: options.startedAt.toISOString(),
        resolved_at: options.resolvedAt?.toISOString() ?? null,
        brewer_id: options.brewerId ?? null,
        cups_made: options.status === "resolved" ? 1 : null,
      })
      .select("id")
      .single();
    if (error) throw error;

    const roundId = data.id as string;
    cleanup.trackRound(roundId);
    return roundId;
  }

  it("submits an Order for the caller in an open round they started", async () => {
    const player = await signUp("order-submit-open");

    const { data: roundId, error: startError } = await player.client.rpc("start_round");
    expect(startError).toBeNull();
    cleanup.trackRound(roundId as string);

    const { error } = await player.client.rpc("submit_order", {
      p_round_id: roundId,
      p_drink_type: "coffee",
    });
    expect(error).toBeNull();

    const { data: row } = await admin
      .from("orders")
      .select("round_id, player_id, drink_type")
      .eq("round_id", roundId)
      .eq("player_id", player.googleSub)
      .single();
    expect(row).toEqual({ round_id: roundId, player_id: player.googleSub, drink_type: "coffee" });
  });

  it("upserts on re-pick instead of creating a second row", async () => {
    const player = await signUp("order-repick");

    const { data: roundId } = await player.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    await player.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "tea" });
    const { error } = await player.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "coffee" });
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from("orders")
      .select("drink_type")
      .eq("round_id", roundId)
      .eq("player_id", player.googleSub);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.drink_type).toBe("coffee");
  });

  it("succeeds even when the caller has no matching Usual set", async () => {
    const player = await signUp("order-no-usual");

    const { data: roundId } = await player.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error } = await player.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "tea" });
    expect(error).toBeNull();
  });

  it("rejects a drink_type other than tea/coffee (RFB28)", async () => {
    const player = await signUp("order-bad-drink");

    const { data: roundId } = await player.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error } = await player.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "juice" });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB28");
  });

  it("rejects a round that does not exist (RFB29)", async () => {
    const player = await signUp("order-missing-round");

    const { error } = await player.client.rpc("submit_order", {
      p_round_id: "00000000-0000-0000-0000-000000000000",
      p_drink_type: "tea",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB29");
  });

  it("rejects a cancelled round (RFB29)", async () => {
    const player = await signUp("order-cancelled-round");

    const roundId = await seedRound({
      roomId: player.roomId,
      startedBy: player.googleSub,
      status: "cancelled",
      startedAt: new Date(),
    });

    const { error } = await player.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "tea" });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB29");
  });

  it("stays open through a round's own resolution", async () => {
    const player = await signUp("order-resolved-round");

    const roundId = await seedRound({
      roomId: player.roomId,
      startedBy: player.googleSub,
      status: "resolved",
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      resolvedAt: new Date(),
      brewerId: player.googleSub,
    });

    const { error } = await player.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "coffee" });
    expect(error).toBeNull();
  });

  it("closes once the room's next round resolves (RFB30, Order Window)", async () => {
    const brewer = await signUp("order-window-brewer");

    const earlierRoundId = await seedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      status: "resolved",
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
      brewerId: brewer.googleSub,
    });
    await seedRound({
      roomId: brewer.roomId,
      startedBy: brewer.googleSub,
      status: "resolved",
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
      resolvedAt: new Date(),
      brewerId: brewer.googleSub,
    });

    const { error } = await brewer.client.rpc("submit_order", {
      p_round_id: earlierRoundId,
      p_drink_type: "tea",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB30");
  });
});

describe.skipIf(!hasAnonTestEnv)("round_menu", () => {
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

  async function setUsual(
    player: { client: SupabaseClient; googleSub: string },
    drinkType: "tea" | "coffee",
    milk: string,
    sugar: string,
    decaf = false,
  ) {
    const { error } = await player.client
      .from("usual_drinks")
      .insert({ player_id: player.googleSub, drink_type: drinkType, milk, sugar, decaf });
    if (error) throw error;
  }

  it("returns each participant's Order with their current Usual's milk/sugar/decaf", async () => {
    const starter = await signUp("menu-happy-starter");
    const other = await signUp("menu-happy-other");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    await setUsual(starter, "tea", "Dairy", "1 Tsp", true);
    await setUsual(other, "coffee", "Oat", "None", false);

    await starter.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "tea" });
    await other.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "coffee" });

    const { data: rows, error } = await admin
      .from("round_menu")
      .select("player_id, drink_type, milk, sugar, decaf, no_preference_set")
      .eq("round_id", roundId)
      .order("player_id", { ascending: true });
    expect(error).toBeNull();

    const byPlayer = new Map((rows ?? []).map((row) => [row.player_id, row]));
    expect(byPlayer.get(starter.googleSub)).toEqual({
      player_id: starter.googleSub,
      drink_type: "tea",
      milk: "Dairy",
      sugar: "1 Tsp",
      decaf: true,
      no_preference_set: false,
    });
    expect(byPlayer.get(other.googleSub)).toEqual({
      player_id: other.googleSub,
      drink_type: "coffee",
      milk: "Oat",
      sugar: "None",
      decaf: false,
      no_preference_set: false,
    });
  });

  it("excludes players who ordered without declaring into the round", async () => {
    const starter = await signUp("menu-nonparticipant-starter");
    const outsider = await signUp("menu-nonparticipant-outsider");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    // Order is decoupled from declare-in (ADR 0004) -- this succeeds even
    // though outsider never declared into this round.
    const { error } = await outsider.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "tea" });
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from("round_menu")
      .select("player_id")
      .eq("round_id", roundId);
    expect((rows ?? []).map((row) => row.player_id)).not.toContain(outsider.googleSub);
  });

  it("excludes declared participants who never placed an Order", async () => {
    const starter = await signUp("menu-no-order-starter");
    const silent = await signUp("menu-no-order-silent");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await silent.client.rpc("declare_in", { p_round_id: roundId });

    await starter.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "tea" });

    const { data: rows } = await admin
      .from("round_menu")
      .select("player_id")
      .eq("round_id", roundId);
    const playerIds = (rows ?? []).map((row) => row.player_id);
    expect(playerIds).toContain(starter.googleSub);
    expect(playerIds).not.toContain(silent.googleSub);
  });

  it("surfaces no_preference_set when the ordering player has no matching Usual", async () => {
    const starter = await signUp("menu-no-usual-starter");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await starter.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "coffee" });

    const { data: row } = await admin
      .from("round_menu")
      .select("drink_type, milk, sugar, decaf, no_preference_set")
      .eq("round_id", roundId)
      .eq("player_id", starter.googleSub)
      .single();
    // decaf comes back false (not null) alongside no_preference_set -- it
    // has no "unset" state distinct from milk/sugar's null, since the
    // underlying column defaults false rather than being nullable.
    expect(row).toEqual({ drink_type: "coffee", milk: null, sugar: null, decaf: false, no_preference_set: true });
  });

  it("only matches a Usual for the same drink_type the player ordered", async () => {
    const starter = await signUp("menu-drink-mismatch-starter");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    // Sets a tea Usual but orders coffee -- the coffee Usual doesn't exist.
    await setUsual(starter, "tea", "Dairy", "1 Tsp");
    await starter.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "coffee" });

    const { data: row } = await admin
      .from("round_menu")
      .select("no_preference_set")
      .eq("round_id", roundId)
      .eq("player_id", starter.googleSub)
      .single();
    expect(row?.no_preference_set).toBe(true);
  });

  it("live-joins Usual: editing it after the round resolves changes the Menu (ADR 0003)", async () => {
    const starter = await signUp("menu-live-join-starter");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await setUsual(starter, "tea", "Dairy", "1 Tsp");
    await starter.client.rpc("submit_order", { p_round_id: roundId, p_drink_type: "tea" });

    await admin
      .from("rounds")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), brewer_id: starter.googleSub, cups_made: 1 })
      .eq("id", roundId);

    const { data: beforeEdit } = await admin
      .from("round_menu")
      .select("milk, sugar")
      .eq("round_id", roundId)
      .eq("player_id", starter.googleSub)
      .single();
    expect(beforeEdit).toEqual({ milk: "Dairy", sugar: "1 Tsp" });

    await starter.client
      .from("usual_drinks")
      .update({ milk: "Soy", sugar: "2 Tsp" })
      .eq("player_id", starter.googleSub)
      .eq("drink_type", "tea");

    const { data: afterEdit } = await admin
      .from("round_menu")
      .select("milk, sugar")
      .eq("round_id", roundId)
      .eq("player_id", starter.googleSub)
      .single();
    expect(afterEdit).toEqual({ milk: "Soy", sugar: "2 Tsp" });
  });
});
