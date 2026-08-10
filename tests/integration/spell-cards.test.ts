import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byTarget,
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// spell-card catalog/deck (0017/0018, issue #66) and pre-roll casting
// (0019, issue #67) RPCs through real signed-in sessions.
describe.skipIf(!hasAnonTestEnv)("spell cards: catalog, draw/hold/swap, pre-roll casting", () => {
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

  it("seeds the catalog with all 71 cards across the documented tier split", async () => {
    const { count: total } = await admin
      .from("spell_cards")
      .select("*", { count: "exact", head: true });
    expect(total).toBe(71);

    const { count: common } = await admin
      .from("spell_cards")
      .select("*", { count: "exact", head: true })
      .eq("tier", "common");
    const { count: rare } = await admin
      .from("spell_cards")
      .select("*", { count: "exact", head: true })
      .eq("tier", "rare");
    const { count: epic } = await admin
      .from("spell_cards")
      .select("*", { count: "exact", head: true })
      .eq("tier", "epic");

    expect(common).toBe(22);
    expect(rare).toBe(35);
    expect(epic).toBe(14);
  });

  it("seeds exactly one deck instance per catalog card", async () => {
    const { count } = await admin
      .from("spell_deck_instances")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(71);
  });

  it("draw_spell_card gives a player holding nothing an immediate held card", async () => {
    const { client } = await signUpSignInAndEnter("draw-empty-handed");

    const { data, error } = await client.rpc("draw_spell_card", { p_trigger: "nat1" });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
    expect(row!.instance_id).toBeTruthy();
    expect(row!.needs_swap_decision).toBe(false);

    const { data: myCards, error: myCardsError } = await client.rpc("get_my_spell_cards");
    expect(myCardsError).toBeNull();
    expect(myCards).toHaveLength(1);
    expect((myCards as { location: string }[])[0]!.location).toBe("held");
  });

  it("draw_spell_card parks a new draw as pending_swap when the player already holds a card", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("draw-already-holding");
    await forceHold(admin, googleSub, "Lucky Sip");

    const { data, error } = await client.rpc("draw_spell_card", { p_trigger: "nat20" });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
    expect(row!.needs_swap_decision).toBe(true);

    const { data: myCards } = await client.rpc("get_my_spell_cards");
    const locations = (myCards as { location: string }[]).map((c) => c.location).sort();
    expect(locations).toEqual(["held", "pending_swap"]);
  });

  it("resolve_card_swap keeping the new card reshuffles the old one back to in_deck", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("swap-keep-new");
    const oldInstanceId = await forceHold(admin, googleSub, "Lucky Sip");
    await client.rpc("draw_spell_card", { p_trigger: "nat1" });

    const { error } = await client.rpc("resolve_card_swap", { p_keep_new: true });
    expect(error).toBeNull();

    const { data: oldInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", oldInstanceId)
      .single();
    expect(oldInstance).toEqual({ location: "in_deck", held_by_player: null });

    const { data: myCards } = await client.rpc("get_my_spell_cards");
    expect(myCards).toHaveLength(1);
    expect((myCards as { location: string; card_name: string }[])[0]!.location).toBe("held");
  });

  it("resolve_card_swap keeping the old card reshuffles the new one back to in_deck", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("swap-keep-old");
    await forceHold(admin, googleSub, "Lucky Sip");
    const { data: drawData } = await client.rpc("draw_spell_card", { p_trigger: "nat1" });
    const [drawRow] = drawData as { instance_id: string }[];
    const newInstanceId = drawRow!.instance_id;

    const { error } = await client.rpc("resolve_card_swap", { p_keep_new: false });
    expect(error).toBeNull();

    const { data: newInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", newInstanceId)
      .single();
    expect(newInstance).toEqual({ location: "in_deck", held_by_player: null });

    const { data: myCards } = await client.rpc("get_my_spell_cards");
    expect(myCards).toHaveLength(1);
    expect((myCards as { card_name: string }[])[0]!.card_name).toBe("Lucky Sip");
  });

  it("casting a self-targeted flat-modifier card composes into get_round_modifier_effects and discards the card", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("cast-self-flat");
    const instanceId = await forceHold(admin, googleSub, "Lucky Sip");

    const { data: roundId } = await client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { data: castId, error } = await client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(error).toBeNull();
    expect(castId).toBeTruthy();

    const { data: effects, error: effectsError } = await client.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    expect(effectsError).toBeNull();
    // Room-wide RPC (get_round_modifier_effects): filter to this test's own
    // target before asserting exact contents (issue #147).
    expect(byTarget(effects as { target_player_id: string }[], googleSub)).toEqual([
      {
        target_player_id: googleSub,
        effect_kind: "flat_modifier",
        effect_params: { delta: 3 },
        resolved_value: null,
        card_name: "Lucky Sip",
        caster_player_id: googleSub,
      },
    ]);

    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", instanceId)
      .single();
    expect(instance).toEqual({ location: "in_deck", held_by_player: null });
  });

  it("an opponent-targeted card can be armed with no target while the round is still open, then targeted after close", async () => {
    const { client: casterClient, googleSub: casterSub } = await signUpSignInAndEnter("cast-opp-caster");
    const { client: targetClient, googleSub: targetSub } = await signUpSignInAndEnter("cast-opp-target");
    await forceHold(admin, casterSub, "Milky Brew");

    const { data: roundId } = await casterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await targetClient.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await casterClient.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    const { data: pending } = await casterClient.rpc("get_my_pending_casts", {
      p_round_id: roundId,
    });
    expect(pending).toEqual([{ cast_id: castId, card_name: "Milky Brew", target: "OPPONENT" }]);

    await casterClient.rpc("declare_in", { p_round_id: roundId });
    const { error: closeError } = await casterClient.rpc("close_round", { p_round_id: roundId });
    expect(closeError).toBeNull();

    const { error: targetError } = await casterClient.rpc("set_spell_cast_target", {
      p_cast_id: castId,
      p_target_player_id: targetSub,
    });
    expect(targetError).toBeNull();

    const { data: effects } = await casterClient.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    // Room-wide RPC (get_round_modifier_effects): filter to this test's own
    // target before asserting exact contents (issue #147).
    expect(byTarget(effects as { target_player_id: string }[], targetSub)).toEqual([
      {
        target_player_id: targetSub,
        effect_kind: "set_modifier",
        effect_params: { value: 0 },
        resolved_value: null,
        card_name: "Milky Brew",
        caster_player_id: casterSub,
      },
    ]);
  });

  it("rejects casting a Reaction card pre-roll", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("cast-reaction-reject");
    await forceHold(admin, googleSub, "Six Sugars"); // Reaction, Self

    const { data: roundId } = await client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error } = await client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(error).not.toBeNull();
  });

  it("rejects casting when the caller is not a participant in the round (issue #244)", async () => {
    const { client: starterClient } = await signUpSignInAndEnter("cast-non-participant-starter");
    const { client: casterClient, googleSub: casterSub } = await signUpSignInAndEnter("cast-non-participant-caster");
    await forceHold(admin, casterSub, "Lucky Sip");

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    // casterClient deliberately never declares into this round.

    const { error } = await casterClient.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("caller is not a participant in this round");
  });

  it("rejects casting once the round has closed (RFB03)", async () => {
    const { client: casterClient, googleSub: casterSub } = await signUpSignInAndEnter("cast-after-close");
    const { client: otherClient } = await signUpSignInAndEnter("cast-after-close-other");
    await forceHold(admin, casterSub, "Lucky Sip");

    const { data: roundId } = await casterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });
    await casterClient.rpc("close_round", { p_round_id: roundId });

    const { error } = await casterClient.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB03");
  });
});
