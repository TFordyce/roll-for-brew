import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// physical-deck spell card draw override (0036) — pending_spell_draws plus
// record_pending_spell_draw/get_pending_spell_draw/draw_pending_spell_card/
// draw_pending_spell_card_manual — through real signed-in sessions.
describe.skipIf(!hasAnonTestEnv)("manual spell card draw: pending draw + physical-deck override", () => {
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

  async function startRoundFor(client: SupabaseClient) {
    const { data: roundId, error } = await client.rpc("start_round");
    if (error) throw error;
    cleanup.trackRound(roundId as string);
    return roundId as string;
  }

  async function cardIdFor(name: string) {
    const { data, error } = await admin.from("spell_cards").select("id").eq("name", name).single();
    if (error) throw error;
    return data.id as string;
  }

  it("record_pending_spell_draw is read back by get_pending_spell_draw", async () => {
    const { client } = await signUpSignInAndEnter("pending-roundtrip");
    const roundId = await startRoundFor(client);

    const { error: recordError } = await client.rpc("record_pending_spell_draw", {
      p_round_id: roundId,
      p_trigger: "nat20",
    });
    expect(recordError).toBeNull();

    const { data, error } = await client.rpc("get_pending_spell_draw", { p_round_id: roundId });
    expect(error).toBeNull();
    expect(data).toEqual([{ trigger: "nat20" }]);
  });

  it("record_pending_spell_draw is idempotent for a repeat call on the same round", async () => {
    const { client } = await signUpSignInAndEnter("pending-idempotent");
    const roundId = await startRoundFor(client);

    await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat1" });
    const { error } = await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat1" });
    expect(error).toBeNull();

    const { data } = await client.rpc("get_pending_spell_draw", { p_round_id: roundId });
    expect(data).toEqual([{ trigger: "nat1" }]);
  });

  it("draw_pending_spell_card draws in-app and clears the pending row", async () => {
    const { client } = await signUpSignInAndEnter("draw-in-app");
    const roundId = await startRoundFor(client);
    await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat1" });

    const { data, error } = await client.rpc("draw_pending_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
    expect(row!.instance_id).toBeTruthy();
    expect(row!.needs_swap_decision).toBe(false);

    const { data: pending } = await client.rpc("get_pending_spell_draw", { p_round_id: roundId });
    expect(pending).toEqual([]);

    const { data: myCards } = await client.rpc("get_my_spell_cards");
    expect(myCards).toHaveLength(1);
  });

  it("draw_pending_spell_card forces the swap on nat1 when the player already holds a card (issue #267)", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("draw-in-app-forced-nat1");
    const oldInstanceId = await forceHold(admin, googleSub, "Lucky Sip");
    const roundId = await startRoundFor(client);
    await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat1" });

    const { data, error } = await client.rpc("draw_pending_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
    expect(row!.needs_swap_decision).toBe(false);

    const { data: oldInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", oldInstanceId)
      .single();
    expect(oldInstance).toEqual({ location: "in_deck", held_by_player: null });

    const { data: myCards } = await client.rpc("get_my_spell_cards");
    expect(myCards).toHaveLength(1);
    expect((myCards as { location: string }[])[0]!.location).toBe("held");
  });

  it("draw_pending_spell_card rejects when there is no pending draw for the round", async () => {
    const { client } = await signUpSignInAndEnter("draw-in-app-no-pending");
    const roundId = await startRoundFor(client);

    const { error } = await client.rpc("draw_pending_spell_card", { p_round_id: roundId });
    expect(error).not.toBeNull();
  });

  it("draw_pending_spell_card_manual forces the swap on nat1 when the player already holds a card (issue #267)", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("draw-manual-forced-nat1");
    const oldInstanceId = await forceHold(admin, googleSub, "Lucky Sip");
    const roundId = await startRoundFor(client);
    await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat1" });
    const cardId = await cardIdFor("Cold Tea");

    const { data, error } = await client.rpc("draw_pending_spell_card_manual", {
      p_round_id: roundId,
      p_card_id: cardId,
    });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
    expect(row!.needs_swap_decision).toBe(false);

    const { data: oldInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", oldInstanceId)
      .single();
    expect(oldInstance).toEqual({ location: "in_deck", held_by_player: null });

    const { data: myCards } = await client.rpc("get_my_spell_cards");
    expect(myCards).toHaveLength(1);
    expect((myCards as { location: string; card_name: string }[])[0]).toMatchObject({
      location: "held",
      card_name: "Cold Tea",
    });
  });

  it("draw_pending_spell_card_manual draws the named card and clears the pending row", async () => {
    const { client } = await signUpSignInAndEnter("draw-manual");
    const roundId = await startRoundFor(client);
    await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat20" });
    const cardId = await cardIdFor("Lucky Sip");

    const { data, error } = await client.rpc("draw_pending_spell_card_manual", {
      p_round_id: roundId,
      p_card_id: cardId,
    });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
    expect(row!.instance_id).toBeTruthy();

    const { data: pending } = await client.rpc("get_pending_spell_draw", { p_round_id: roundId });
    expect(pending).toEqual([]);

    const { data: myCards } = await client.rpc("get_my_spell_cards");
    expect((myCards as { card_name: string }[])[0]!.card_name).toBe("Lucky Sip");
  });

  it("draw_pending_spell_card_manual rejects a card with no in-deck instance (RFB06) and leaves the pending row intact", async () => {
    // Second player ("someone else already holds Lucky Sip") is independent
    // of the first, so create both up front.
    const [{ client }, { googleSub: otherSub }] = await Promise.all([
      signUpSignInAndEnter("draw-manual-desync"),
      signUpSignInAndEnter("draw-manual-desync-holder"),
    ]);
    await forceHold(admin, otherSub, "Lucky Sip");

    const roundId = await startRoundFor(client);
    await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat1" });
    const cardId = await cardIdFor("Lucky Sip");

    const { error } = await client.rpc("draw_pending_spell_card_manual", {
      p_round_id: roundId,
      p_card_id: cardId,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB06");

    const { data: pending } = await client.rpc("get_pending_spell_draw", { p_round_id: roundId });
    expect(pending).toEqual([{ trigger: "nat1" }]);

    // The caller never got a card out of the failed attempt.
    const { data: myCards } = await client.rpc("get_my_spell_cards");
    expect(myCards).toEqual([]);
  });
});
