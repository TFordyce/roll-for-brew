import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Issue #471: an admin allocation
// is not a draw, so it bypasses a live Stale Biscuit mark ("Mark a target.
// The very next card they would draw goes to you instead.") -- but not
// silently. admin_allocate_spell_card refuses with RFB57 while the target has
// a live next_draw Draw Redirect mark, and the admin re-submits with
// p_mark_choice: 'target' (allocate anyway, the mark stays live) or
// 'beneficiary' (the card goes where the mark sends it, as a draw would, and
// the mark is spent). Cancelling is simply not re-submitting.
//
// Each test allocates its own catalog card, never reused across tests or
// other suites, so a card left held cannot leak between them.

type AllocationRow = { instance_id: string; recipient_player_id: string; draw_redirect_outcome: string | null };

const MARK_PARAMS = { trigger: "next_draw", persist: true };

describe.skipIf(!hasAnonTestEnv)("admin card allocation with a live Stale Biscuit mark (issue #471)", () => {
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

  /** An admin, a target, and the beneficiary who has a live Stale Biscuit mark on the target. */
  async function seedMark(label: string) {
    const [allocator, target, beneficiary] = await Promise.all(
      ["admin", "target", "beneficiary"].map((role) => signUp(`aadr-${label}-${role}`)),
    );
    const { error: adminErr } = await admin.from("players").update({ is_admin: true }).eq("id", allocator!.googleSub);
    expect(adminErr).toBeNull();
    const roomId = await seedDedicatedRoom(admin, cleanup, [target!.googleSub, beneficiary!.googleSub]);
    const { castId } = await seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId: target!.googleSub,
      casterId: beneficiary!.googleSub,
      cardName: "Stale Biscuit",
      effectKind: "draw_redirect",
      effectParams: MARK_PARAMS,
    });
    return { allocator: allocator!, target: target!, beneficiary: beneficiary!, castId };
  }

  async function cardIdFor(name: string) {
    const { data, error } = await admin.from("spell_cards").select("id").eq("name", name).single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function instanceOf(cardId: string) {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("id, location, held_by_player")
      .eq("card_id", cardId)
      .single();
    expect(error).toBeNull();
    return data as { id: string; location: string; held_by_player: string | null };
  }

  async function drawLog(instanceId: string) {
    const { data, error } = await admin
      .from("spell_draws")
      .select("id, player_id, trigger")
      .eq("card_instance_id", instanceId);
    expect(error).toBeNull();
    return (data ?? []) as { id: string; player_id: string; trigger: string }[];
  }

  async function castInputs(castId: string) {
    const { data, error } = await admin.from("spell_casts").select("cast_inputs").eq("id", castId).single();
    expect(error).toBeNull();
    return (data!.cast_inputs ?? {}) as Record<string, unknown>;
  }

  async function unassign(client: SupabaseClient, cardId: string) {
    const { error } = await client.rpc("admin_unassign_spell_card", { p_card_id: cardId });
    expect(error).toBeNull();
  }

  it("refuses with RFB57 naming the beneficiary, and changes nothing", async () => {
    const { allocator, target, beneficiary, castId } = await seedMark("warn");
    const cardId = await cardIdFor("Tea Leaf");

    const { error } = await allocator.client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: target.googleSub,
    });

    expect(error?.code).toBe("RFB57");
    expect(error?.message).toContain("Stale Biscuit");
    expect(error?.details).toBe(beneficiary.googleSub);
    expect(await instanceOf(cardId)).toMatchObject({ location: "in_deck", held_by_player: null });
    expect(await castInputs(castId)).not.toHaveProperty("consumed_by_draw");
  });

  it("'target': allocates to the target anyway and the mark stays live", async () => {
    const { allocator, target, castId } = await seedMark("target");
    const cardId = await cardIdFor("Spillage");

    const { data, error } = await allocator.client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: target.googleSub,
      p_mark_choice: "target",
    });

    expect(error).toBeNull();
    const instance = await instanceOf(cardId);
    expect(data as AllocationRow[]).toEqual([
      { instance_id: instance.id, recipient_player_id: target.googleSub, draw_redirect_outcome: null },
    ]);
    expect(instance).toMatchObject({ location: "held", held_by_player: target.googleSub });
    expect((await drawLog(instance.id)).map((r) => [r.player_id, r.trigger])).toEqual([
      [target.googleSub, "admin_allocation"],
    ]);
    expect(await castInputs(castId)).not.toHaveProperty("consumed_by_draw");

    // Still live: the next allocation to the target warns again.
    await unassign(allocator.client, cardId);
    const { error: again } = await allocator.client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: target.googleSub,
    });
    expect(again?.code).toBe("RFB57");
  });

  it("'beneficiary': the card goes to the marker and the mark is spent", async () => {
    const { allocator, target, beneficiary, castId } = await seedMark("beneficiary");
    const cardId = await cardIdFor("Genie in the Teapot");

    const { data, error } = await allocator.client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: target.googleSub,
      p_mark_choice: "beneficiary",
    });

    expect(error).toBeNull();
    const instance = await instanceOf(cardId);
    expect(data as AllocationRow[]).toEqual([
      { instance_id: instance.id, recipient_player_id: beneficiary.googleSub, draw_redirect_outcome: "redirected" },
    ]);
    expect(instance).toMatchObject({ location: "held", held_by_player: beneficiary.googleSub });
    const log = await drawLog(instance.id);
    expect(log.map((r) => [r.player_id, r.trigger])).toEqual([[beneficiary.googleSub, "admin_allocation"]]);
    expect(await castInputs(castId)).toMatchObject({
      consumed_by_draw: log[0]!.id,
      draw_redirect_outcome: "redirected",
    });

    // Spent: the target's next allocation goes through with no warning.
    const otherCardId = await cardIdFor("Yorkshire Terror");
    const { error: next } = await allocator.client.rpc("admin_allocate_spell_card", {
      p_card_id: otherCardId,
      p_player_id: target.googleSub,
    });
    expect(next).toBeNull();
    expect(await instanceOf(otherCardId)).toMatchObject({ held_by_player: target.googleSub });
  });

  it("'beneficiary' with a card already held: it lands as their keep-or-swap choice", async () => {
    const { allocator, target, beneficiary } = await seedMark("swap");
    await forceHold(admin, beneficiary.googleSub, "Steady Hand");
    const cardId = await cardIdFor("Topsy-Tea");

    const { error } = await allocator.client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: target.googleSub,
      p_mark_choice: "beneficiary",
    });

    expect(error).toBeNull();
    expect(await instanceOf(cardId)).toMatchObject({ location: "pending_swap", held_by_player: beneficiary.googleSub });
  });

  it("'beneficiary' with a full hand fizzles: the target gets the card and the mark is spent", async () => {
    const { allocator, target, beneficiary, castId } = await seedMark("fizzle");
    const pending = await forceHold(admin, beneficiary.googleSub, "Sleeping Camomile");
    const { error: pErr } = await admin.from("spell_deck_instances").update({ location: "pending_swap" }).eq("id", pending);
    expect(pErr).toBeNull();
    await forceHold(admin, beneficiary.googleSub, "Steady Hand");
    const cardId = await cardIdFor("Prophe-Tea");

    const { data, error } = await allocator.client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: target.googleSub,
      p_mark_choice: "beneficiary",
    });

    expect(error).toBeNull();
    const instance = await instanceOf(cardId);
    expect(data as AllocationRow[]).toEqual([
      { instance_id: instance.id, recipient_player_id: target.googleSub, draw_redirect_outcome: "fizzled" },
    ]);
    expect(instance).toMatchObject({ location: "held", held_by_player: target.googleSub });
    const log = await drawLog(instance.id);
    expect(log.map((r) => r.player_id)).toEqual([target.googleSub]);
    expect(await castInputs(castId)).toMatchObject({
      consumed_by_draw: log[0]!.id,
      draw_redirect_outcome: "fizzled",
    });
  });

  it("'beneficiary' when the target has no live mark is refused", async () => {
    const [allocator, target] = await Promise.all([signUp("aadr-nomark-admin"), signUp("aadr-nomark-target")]);
    const { error: adminErr } = await admin.from("players").update({ is_admin: true }).eq("id", allocator.googleSub);
    expect(adminErr).toBeNull();
    const cardId = await cardIdFor("Eternal Steep");

    const { error } = await allocator.client.rpc("admin_allocate_spell_card", {
      p_card_id: cardId,
      p_player_id: target.googleSub,
      p_mark_choice: "beneficiary",
    });

    expect(error).not.toBeNull();
    expect(await instanceOf(cardId)).toMatchObject({ location: "in_deck" });
  });
});
