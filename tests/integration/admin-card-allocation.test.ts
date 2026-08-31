import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, forceHold, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the admin
// spell card allocation tool (0047, issue #154) —
// admin_get_card_assignments/admin_allocate_spell_card/admin_unassign_spell_card
// — through real signed-in sessions.
//
// Each test below uses its own dedicated catalog card, never reused across
// tests: a held instance's player_id FK (0018) blocks createTestCleanup
// from deleting a still-holding player, so a card left held at the end of
// one test can otherwise leak into whichever later test reuses its name.
describe.skipIf(!hasAnonTestEnv)("admin card allocation: assign/unassign real players' held cards", () => {
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

  async function cardIdFor(name: string) {
    const { data, error } = await admin.from("spell_cards").select("id").eq("name", name).single();
    if (error) throw error;
    return data.id as string;
  }

  it("rejects a non-admin caller", async () => {
    const { client } = await signUpSignInAndEnter("not-admin");
    const { error } = await client.rpc("admin_get_card_assignments");
    expect(error).not.toBeNull();
  });

  it("admin_allocate_spell_card assigns the card, held_by_player, and a spell_draws row", async () => {
    const [{ client, googleSub }, { googleSub: targetSub }] = await Promise.all([
      signUpSignInAndEnter("allocator"),
      signUpSignInAndEnter("allocatee"),
    ]);
    await makeAdmin(googleSub);
    const cardId = await cardIdFor("Lucky Sip");

    const { data, error } = await client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: targetSub,
    });
    expect(error).toBeNull();
    const [row] = data as { instance_id: string }[];
    expect(row!.instance_id).toBeTruthy();

    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", row!.instance_id)
      .single();
    expect(instance).toEqual({ location: "held", held_by_player: targetSub });

    const { data: draws } = await admin
      .from("spell_draws")
      .select("player_id, trigger")
      .eq("card_instance_id", row!.instance_id);
    expect(draws).toEqual([{ player_id: targetSub, trigger: "admin_allocation" }]);
  });

  it("appears in the assigned player's spell collection as discovered", async () => {
    const [{ client, googleSub }, { client: targetClient, googleSub: targetSub }] =
      await Promise.all([
        signUpSignInAndEnter("allocator-collection"),
        signUpSignInAndEnter("allocatee-collection"),
      ]);
    await makeAdmin(googleSub);
    const cardId = await cardIdFor("Six Sugars");

    const allocResult = await client.rpc("admin_allocate_spell_card", { p_card_id: cardId, p_player_id: targetSub });
    if (allocResult.error) throw allocResult.error;

    const { data: collection, error } = await targetClient.rpc("get_player_spell_collection", {
      p_player_id: targetSub,
    });
    expect(error).toBeNull();
    const row = (collection as { name: string; draw_count: number }[]).find((c) => c.name === "Six Sugars");
    expect(row?.draw_count).toBeGreaterThan(0);
  });

  it("rejects assigning a card that's already held by someone else (RFB07)", async () => {
    const [{ client, googleSub }, { googleSub: holderSub }, { googleSub: targetSub }] =
      await Promise.all([
        signUpSignInAndEnter("allocator-conflict"),
        signUpSignInAndEnter("holder-conflict"),
        signUpSignInAndEnter("target-conflict"),
      ]);
    await makeAdmin(googleSub);
    await forceHold(admin, holderSub, "Caffeinated Focus");
    const cardId = await cardIdFor("Caffeinated Focus");

    const { error } = await client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: targetSub,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB07");

    // The failed attempt never touched the target's hand.
    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("held_by_player")
      .eq("card_id", cardId)
      .single();
    expect(instance?.held_by_player).toBe(holderSub);
  });

  it("rejects assigning to a player who already holds a different card (RFB08)", async () => {
    const [{ client, googleSub }, { googleSub: targetSub }] = await Promise.all([
      signUpSignInAndEnter("allocator-target-conflict"),
      signUpSignInAndEnter("target-already-holding"),
    ]);
    await makeAdmin(googleSub);
    await forceHold(admin, targetSub, "Double Dunk");
    const otherCardId = await cardIdFor("Milk First?");

    const { error } = await client.rpc("admin_allocate_spell_card", {
      p_card_id: otherCardId,
      p_player_id: targetSub,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB08");
  });

  it("admin_unassign_spell_card returns a held card to in_deck without touching spell_draws", async () => {
    const [{ client, googleSub }, { googleSub: holderSub }] = await Promise.all([
      signUpSignInAndEnter("unassigner"),
      signUpSignInAndEnter("held-then-unassigned"),
    ]);
    await makeAdmin(googleSub);
    const instanceId = await forceHold(admin, holderSub, "Slipped Spoon");
    const cardId = await cardIdFor("Slipped Spoon");

    const { error } = await client.rpc("admin_unassign_spell_card", { p_card_id: cardId });
    expect(error).toBeNull();

    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", instanceId)
      .single();
    expect(instance).toEqual({ location: "in_deck", held_by_player: null });
  });

  it("rejects unassigning a card that's already in_deck (RFB09)", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("unassigner-noop");
    await makeAdmin(googleSub);
    const cardId = await cardIdFor("Cold Tea");

    const { error } = await client.rpc("admin_unassign_spell_card", { p_card_id: cardId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB09");
  });

  it("after unassign, the card can be reassigned to a different player", async () => {
    const [{ client, googleSub }, { googleSub: firstHolder }, { googleSub: secondHolder }] =
      await Promise.all([
        signUpSignInAndEnter("reassigner"),
        signUpSignInAndEnter("first-holder"),
        signUpSignInAndEnter("second-holder"),
      ]);
    await makeAdmin(googleSub);
    await forceHold(admin, firstHolder, "Sugar Rush");
    const cardId = await cardIdFor("Sugar Rush");

    await client.rpc("admin_unassign_spell_card", { p_card_id: cardId });
    const { error } = await client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: secondHolder,
    });
    expect(error).toBeNull();

    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("held_by_player")
      .eq("card_id", cardId)
      .single();
    expect(instance?.held_by_player).toBe(secondHolder);
  });

  it("admin_get_card_assignments reports every catalog card with its holder", async () => {
    const [{ client, googleSub }, { googleSub: holderSub }] = await Promise.all([
      signUpSignInAndEnter("lister"),
      signUpSignInAndEnter("listed-holder"),
    ]);
    await makeAdmin(googleSub);
    await forceHold(admin, holderSub, "Tea Party Revolt");

    const { data, error } = await client.rpc("admin_get_card_assignments");
    expect(error).toBeNull();
    const rows = data as { name: string; location: string; held_by_player: string | null }[];
    expect(rows.length).toBeGreaterThanOrEqual(71);
    const held = rows.find((r) => r.name === "Tea Party Revolt");
    expect(held).toMatchObject({ location: "held", held_by_player: holderSub });
  });
});
