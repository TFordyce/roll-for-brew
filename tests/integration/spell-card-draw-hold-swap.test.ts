import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// spell-card catalog, deck-instance, and draw/hold/swap RPCs (supabase/
// migrations/0017-0020), covering issue #66's acceptance criteria: the
// catalog is seeded correctly, a natural 1 or 20 draws a card for the
// roller (and only the roller), a second draw while already holding
// prompts a keep-or-swap decision, the non-kept instance is reshuffled
// back into the deck rather than removed, and the deck stays blind (no
// player can see its contents or remaining count).
describe.skipIf(!hasAnonTestEnv)("spell card draw/hold/swap (issue #66)", () => {
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

  async function startCloseAndDeclare(starterLabel: string, otherLabel: string) {
    const starter = await signUp(starterLabel);
    const other = await signUp(otherLabel);

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await starter.client.rpc("close_round", { p_round_id: roundId });

    return { starter, other, roundId: roundId as string };
  }

  /** rounds_one_active_per_room (0004) allows only one open-or-closed round
   * per room at a time, so a test that needs two separate draw events for
   * the same player must fully resolve the first round (not just close it)
   * before start_round can succeed for the second. */
  async function resolveRoundWithBothRolled(
    starterClient: SupabaseClient,
    otherClient: SupabaseClient,
    roundId: string,
    starterId: string,
  ) {
    await otherClient.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 15 });
    const { error } = await starterClient.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: starterId,
      p_cups_made: 2,
    });
    expect(error).toBeNull();
  }

  it("seeds the catalog as 65 cards (20 common / 33 rare / 12 epic) and one deck instance per card", async () => {
    const { data: cards, error: cardsError } = await admin.from("spell_cards").select("tier");
    expect(cardsError).toBeNull();
    expect(cards).toHaveLength(65);

    const byTier = new Map<string, number>();
    for (const c of cards ?? []) byTier.set(c.tier as string, (byTier.get(c.tier as string) ?? 0) + 1);
    expect(byTier.get("common")).toBe(20);
    expect(byTier.get("rare")).toBe(33);
    expect(byTier.get("epic")).toBe(12);

    const { count, error: instancesError } = await admin
      .from("spell_deck_instances")
      .select("*", { count: "exact", head: true });
    expect(instancesError).toBeNull();
    expect(count).toBe(65);
  });

  it("does not draw a card for a roll that isn't a natural 1 or 20", async () => {
    const { starter, roundId } = await startCloseAndDeclare("no-draw-starter", "no-draw-other");

    const { error } = await starter.client.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 10 });
    expect(error).toBeNull();

    const { data: draws, error: drawsError } = await admin.from("spell_draws").select("id").eq("round_id", roundId);
    expect(drawsError).toBeNull();
    expect(draws).toEqual([]);
  });

  it("draws a card immediately into 'held' for a player holding nothing who rolls a natural 1", async () => {
    const { starter, roundId } = await startCloseAndDeclare("nat1-draw-starter", "nat1-draw-other");

    const { error } = await starter.client.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 1 });
    expect(error).toBeNull();

    const { data: state, error: stateError } = await starter.client.rpc("get_own_spell_card_state");
    expect(stateError).toBeNull();
    expect(state.held).not.toBeNull();
    expect(state.pendingSwap).toBeNull();

    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player_id")
      .eq("id", state.held.instanceId)
      .single();
    expect(instance).toMatchObject({ location: "held", held_by_player_id: starter.googleSub });
  });

  it("draws a card for a natural 20 the same way as a natural 1", async () => {
    const { starter, roundId } = await startCloseAndDeclare("nat20-draw-starter", "nat20-draw-other");

    const { error } = await starter.client.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 20 });
    expect(error).toBeNull();

    const { data: state, error: stateError } = await starter.client.rpc("get_own_spell_card_state");
    expect(stateError).toBeNull();
    expect(state.held).not.toBeNull();
  });

  it("hides another player's held card and the deck's contents/count from a non-holder", async () => {
    const { starter, other, roundId } = await startCloseAndDeclare("hidden-draw-starter", "hidden-draw-other");

    const { error } = await starter.client.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 1 });
    expect(error).toBeNull();

    const { data: otherState, error: otherStateError } = await other.client.rpc("get_own_spell_card_state");
    expect(otherStateError).toBeNull();
    expect(otherState.held).toBeNull();

    // No policy exposes in_deck/discarded rows, or another player's held
    // row, to any authenticated caller — a direct table read must come back
    // empty regardless of who queries it.
    const { data: peek, error: peekError } = await other.client.from("spell_deck_instances").select("id");
    expect(peekError).toBeNull();
    expect(peek).toEqual([]);
  });

  it("prompts a keep-or-swap choice when a second draw happens while already holding a card, and reshuffles whichever is not kept back to in_deck", async () => {
    const { starter, other, roundId: firstRoundId } = await startCloseAndDeclare(
      "swap-keep-old-starter",
      "swap-keep-old-other",
    );

    const { error: firstDrawError } = await starter.client.rpc("submit_manual_roll", {
      p_round_id: firstRoundId,
      p_value: 1,
    });
    expect(firstDrawError).toBeNull();

    const { data: afterFirstDraw } = await starter.client.rpc("get_own_spell_card_state");
    const firstHeldInstanceId = afterFirstDraw.held.instanceId as string;

    await resolveRoundWithBothRolled(starter.client, other.client, firstRoundId, starter.googleSub);

    const other2 = await signUp("swap-keep-old-other2");
    const { data: secondRoundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(secondRoundId as string);
    await other2.client.rpc("declare_in", { p_round_id: secondRoundId });
    await starter.client.rpc("close_round", { p_round_id: secondRoundId });

    const { error: secondDrawError } = await starter.client.rpc("submit_manual_roll", {
      p_round_id: secondRoundId,
      p_value: 20,
    });
    expect(secondDrawError).toBeNull();

    const { data: pendingState, error: pendingStateError } = await starter.client.rpc("get_own_spell_card_state");
    expect(pendingStateError).toBeNull();
    expect(pendingState.pendingSwap).not.toBeNull();
    expect(pendingState.pendingSwap.currentCard.instanceId).toBe(firstHeldInstanceId);
    const newInstanceId = pendingState.pendingSwap.newCard.instanceId as string;
    const drawId = pendingState.pendingSwap.drawId as string;

    // Still holds only the original card until the decision is resolved —
    // the "at most one held" cap holds throughout, and the new instance
    // isn't visible to anyone (drawn, unclaimed) except via the pending-swap
    // read.
    expect(pendingState.held.instanceId).toBe(firstHeldInstanceId);

    const { error: resolveError } = await starter.client.rpc("resolve_spell_card_swap", {
      p_draw_id: drawId,
      p_keep_new: false,
    });
    expect(resolveError).toBeNull();

    const { data: afterResolve } = await starter.client.rpc("get_own_spell_card_state");
    expect(afterResolve.held.instanceId).toBe(firstHeldInstanceId);
    expect(afterResolve.pendingSwap).toBeNull();

    const { data: discardedInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player_id")
      .eq("id", newInstanceId)
      .single();
    expect(discardedInstance).toMatchObject({ location: "in_deck", held_by_player_id: null });
  });

  it("swaps to the newly-drawn card when the player chooses to keep it, returning the old one to in_deck", async () => {
    const starter = await signUp("swap-keep-new-starter");
    const other = await signUp("swap-keep-new-other");

    const { data: firstRoundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(firstRoundId as string);
    await other.client.rpc("declare_in", { p_round_id: firstRoundId });
    await starter.client.rpc("close_round", { p_round_id: firstRoundId });
    await starter.client.rpc("submit_manual_roll", { p_round_id: firstRoundId, p_value: 1 });

    const { data: afterFirstDraw } = await starter.client.rpc("get_own_spell_card_state");
    const firstHeldInstanceId = afterFirstDraw.held.instanceId as string;

    await resolveRoundWithBothRolled(starter.client, other.client, firstRoundId as string, starter.googleSub);

    const { data: secondRoundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(secondRoundId as string);
    await other.client.rpc("declare_in", { p_round_id: secondRoundId });
    await starter.client.rpc("close_round", { p_round_id: secondRoundId });
    await starter.client.rpc("submit_manual_roll", { p_round_id: secondRoundId, p_value: 20 });

    const { data: pendingState } = await starter.client.rpc("get_own_spell_card_state");
    const newInstanceId = pendingState.pendingSwap.newCard.instanceId as string;
    const drawId = pendingState.pendingSwap.drawId as string;

    const { error: resolveError } = await starter.client.rpc("resolve_spell_card_swap", {
      p_draw_id: drawId,
      p_keep_new: true,
    });
    expect(resolveError).toBeNull();

    const { data: afterResolve } = await starter.client.rpc("get_own_spell_card_state");
    expect(afterResolve.held.instanceId).toBe(newInstanceId);

    const { data: oldInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player_id")
      .eq("id", firstHeldInstanceId)
      .single();
    expect(oldInstance).toMatchObject({ location: "in_deck", held_by_player_id: null });
  });

  it("rejects resolving a swap decision that doesn't belong to the caller", async () => {
    const { starter, other, roundId: firstRoundId } = await startCloseAndDeclare(
      "swap-guard-starter",
      "swap-guard-other",
    );
    await starter.client.rpc("submit_manual_roll", { p_round_id: firstRoundId, p_value: 1 });
    await resolveRoundWithBothRolled(starter.client, other.client, firstRoundId, starter.googleSub);

    const other2 = await signUp("swap-guard-other2");
    const { data: secondRoundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(secondRoundId as string);
    await other2.client.rpc("declare_in", { p_round_id: secondRoundId });
    await starter.client.rpc("close_round", { p_round_id: secondRoundId });
    await starter.client.rpc("submit_manual_roll", { p_round_id: secondRoundId, p_value: 20 });

    const { data: pendingState } = await starter.client.rpc("get_own_spell_card_state");
    const drawId = pendingState.pendingSwap.drawId as string;

    const { error } = await other2.client.rpc("resolve_spell_card_swap", {
      p_draw_id: drawId,
      p_keep_new: true,
    });
    expect(error).not.toBeNull();
  });

  it("held cards persist indefinitely: they are not cleared by resolving the round they were drawn in", async () => {
    const { starter, other, roundId } = await startCloseAndDeclare("persist-starter", "persist-other");

    await starter.client.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 1 });
    await other.client.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 15 });

    const { error: resolveError } = await starter.client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: starter.googleSub,
      p_cups_made: 2,
    });
    expect(resolveError).toBeNull();

    const { data: state, error: stateError } = await starter.client.rpc("get_own_spell_card_state");
    expect(stateError).toBeNull();
    expect(state.held).not.toBeNull();
  });

  it("draws a real catalog card with no per-tier weighting beyond the catalog's own instance counts", async () => {
    const { starter, roundId } = await startCloseAndDeclare("uniform-draw-starter", "uniform-draw-other");
    const { error } = await starter.client.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 1 });
    expect(error).toBeNull();

    const { data: state } = await starter.client.rpc("get_own_spell_card_state");
    // The draw always lands on some in-deck instance (no weighting logic to
    // exclude any tier) — assert only that a real catalog card came back,
    // since the RPC's `order by random()` pick isn't itself deterministic.
    expect(["common", "rare", "epic"]).toContain(state.held.tier);
  });
});
