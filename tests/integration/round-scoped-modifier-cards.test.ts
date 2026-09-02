import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Covers issue #343 — the three
// round-scoped modifier snapshot cards (migration 0087):
//
//   * Bes-Tea (Common, OPPONENT) — copy the target's effective modifier
//     onto the caster for this round only.
//   * Tea Leaf (Rare, OPPONENT) — target's modifier drops to 0 this round;
//     the stolen amount is added to the caster's roll.
//   * Spillage (Rare, OPPONENT) — floor(m/2) leaves the target this round
//     and joins the caster's roll.
//
// cast_spell_card emits round-scoped modifier casts (flat_modifier /
// set_modifier, no duration) that resolve_round Phase 4a composes for the
// current round and never persists — room_players.modifier (the #311
// cache) is left untouched. Ward interaction is out of scope (#344).

type TraceStep = {
  index: number;
  display_kind: string;
  source_cast: { cast_id: string | null; card_name: string | null };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  brewer_id: string | null;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("Round-scoped modifier snapshot cards (issue #343)", () => {
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

  // modifier_snapshot is the player's base modifier captured at roll time —
  // resolve_round Phase 4a composes round effects on top of it, so it must
  // reflect the base the round-scoped cast is expected to override / adjust.
  async function seedRoll(roundId: string, playerId: string, value: number, modifierSnapshot = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: modifierSnapshot,
    });
    expect(error).toBeNull();
  }

  /** start_round + everyone else declares in; returns the still-open round id. */
  async function openRound(
    starter: Awaited<ReturnType<typeof signUp>>,
    others: Awaited<ReturnType<typeof signUp>>[],
  ) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  /** Gives `target` a real base modifier via the logged-adjustment RPC. */
  async function bumpModifier(
    actor: Awaited<ReturnType<typeof signUp>>,
    targetPlayerId: string,
    delta: number,
  ) {
    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: targetPlayerId,
      p_delta: delta,
      p_reason: "test seed",
    });
    expect(error).toBeNull();
  }

  async function modifierCache(roomId: string, playerId: string): Promise<number> {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", roomId)
      .eq("player_id", playerId)
      .single();
    expect(error).toBeNull();
    return data!.modifier as number;
  }

  async function castRows(roundId: string) {
    const { data, error } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, cast_inputs, target_player_id, target_pending, negated, target_role")
      .eq("round_id", roundId)
      .order("seq", { ascending: true });
    expect(error).toBeNull();
    return data!;
  }

  // ---------------------------------------------------------------------
  // Un-benched: all three are back in the draw pool (migration 0087).
  // ---------------------------------------------------------------------
  for (const name of ["Bes-Tea", "Tea Leaf", "Spillage"]) {
    it(`${name}'s deck instance is drawable (location = 'in_deck', unheld)`, async () => {
      const { data: card } = await admin
        .from("spell_cards")
        .select("id")
        .eq("name", name)
        .single();

      const { data: instance } = await admin
        .from("spell_deck_instances")
        .select("location, held_by_player")
        .eq("card_id", card!.id)
        .single();
      expect(instance).toEqual({ location: "in_deck", held_by_player: null });
    });
  }

  // ---------------------------------------------------------------------
  // Bes-Tea
  // ---------------------------------------------------------------------
  it("Bes-Tea emits one round-scoped set_modifier on the caster snapshotting the target's modifier", async () => {
    const [caster, target] = await Promise.all([
      signUp("bestea-caster"),
      signUp("bestea-target"),
    ]);
    await bumpModifier(caster, target.googleSub, 6);
    await forceHold(admin, caster.googleSub, "Bes-Tea");

    const roundId = await openRound(caster, [target]);
    const { error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(error).toBeNull();

    const rows = await castRows(roundId);
    expect(rows).toEqual([
      {
        effect_kind: "set_modifier",
        effect_params: { value: 6 },
        cast_inputs: { source_modifier: 6 },
        target_player_id: caster.googleSub,
        target_pending: false,
        negated: false,
        target_role: "CASTER",
      },
    ]);
  });

  it("Bes-Tea sets the caster's modifier for the round only and leaves the cache untouched", async () => {
    const [caster, target, third] = await Promise.all([
      signUp("bestea-resolve-caster"),
      signUp("bestea-resolve-target"),
      signUp("bestea-resolve-third"),
    ]);
    await bumpModifier(caster, target.googleSub, 6);
    await forceHold(admin, caster.googleSub, "Bes-Tea");

    const roundId = await openRound(caster, [target, third]);
    await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await seedRoll(roundId, caster.googleSub, 3, 0); // set_modifier 6 -> 3 + 6 = 9
    await seedRoll(roundId, target.googleSub, 10, 6); // 10 + 6 = 16
    await seedRoll(roundId, third.googleSub, 20, 0);

    const out = await resolve(caster.client, roundId);

    const step = out.trace.find((s) => s.source_cast.card_name === "Bes-Tea");
    expect(step).toMatchObject({
      display_kind: "set_modifier",
      target_player: caster.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 6 },
    });
    // Composed 9 is the lowest — caster brews.
    expect(out.brewer_id).toBe(caster.googleSub);

    // The #311 cache never moved: caster still has no base modifier.
    expect(await modifierCache(caster.roomId, caster.googleSub)).toBe(0);
    expect(await modifierCache(target.roomId, target.googleSub)).toBe(6);
  });

  // ---------------------------------------------------------------------
  // Tea Leaf
  // ---------------------------------------------------------------------
  it("Tea Leaf zeroes the target's modifier and adds the stolen amount to the caster's roll, for the round only", async () => {
    const [caster, target] = await Promise.all([
      signUp("tealeaf-caster"),
      signUp("tealeaf-target"),
    ]);
    await bumpModifier(caster, target.googleSub, 8);
    await forceHold(admin, caster.googleSub, "Tea Leaf");

    const roundId = await openRound(caster, [target]);
    await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });

    const rows = await castRows(roundId);
    expect(rows).toEqual([
      {
        effect_kind: "set_modifier",
        effect_params: { value: 0 },
        cast_inputs: { stolen_amount: 8 },
        target_player_id: target.googleSub,
        target_pending: false,
        negated: false,
        target_role: "TARGET",
      },
      {
        effect_kind: "flat_modifier",
        effect_params: { delta: 8 },
        cast_inputs: { stolen_amount: 8 },
        target_player_id: caster.googleSub,
        target_pending: false,
        negated: false,
        target_role: "CASTER",
      },
    ]);

    await caster.client.rpc("close_round", { p_round_id: roundId });
    await seedRoll(roundId, caster.googleSub, 5, 0); // flat +8 -> 5 + 8 = 13
    await seedRoll(roundId, target.googleSub, 4, 8); // set 0 -> 4 + 0 = 4

    const out = await resolve(caster.client, roundId);

    const targetStep = out.trace.find(
      (s) => s.source_cast.card_name === "Tea Leaf" && s.target_player === target.googleSub,
    );
    expect(targetStep).toMatchObject({
      display_kind: "set_modifier",
      before: { type: "modifier", value: 8 },
      after: { type: "modifier", value: 0 },
    });
    const casterStep = out.trace.find(
      (s) => s.source_cast.card_name === "Tea Leaf" && s.target_player === caster.googleSub,
    );
    expect(casterStep).toMatchObject({
      display_kind: "flat_modifier",
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 8 },
    });
    // target composed 4 is lowest — target brews.
    expect(out.brewer_id).toBe(target.googleSub);

    // Cache unchanged: the adjustment base stays, the round effect is gone.
    expect(await modifierCache(target.roomId, target.googleSub)).toBe(8);
    expect(await modifierCache(caster.roomId, caster.googleSub)).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Spillage
  // ---------------------------------------------------------------------
  it("Spillage moves floor(m/2) from the target to the caster for the round only", async () => {
    const [caster, target] = await Promise.all([
      signUp("spillage-caster"),
      signUp("spillage-target"),
    ]);
    await bumpModifier(caster, target.googleSub, 5); // floor(5/2) = 2
    await forceHold(admin, caster.googleSub, "Spillage");

    const roundId = await openRound(caster, [target]);
    await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });

    const rows = await castRows(roundId);
    expect(rows).toEqual([
      {
        effect_kind: "flat_modifier",
        effect_params: { delta: -2 },
        cast_inputs: { stolen_amount: 2 },
        target_player_id: target.googleSub,
        target_pending: false,
        negated: false,
        target_role: "TARGET",
      },
      {
        effect_kind: "flat_modifier",
        effect_params: { delta: 2 },
        cast_inputs: { stolen_amount: 2 },
        target_player_id: caster.googleSub,
        target_pending: false,
        negated: false,
        target_role: "CASTER",
      },
    ]);

    await caster.client.rpc("close_round", { p_round_id: roundId });
    await seedRoll(roundId, caster.googleSub, 10, 0); // flat +2 -> 10 + 2 = 12
    await seedRoll(roundId, target.googleSub, 10, 5); // flat -2 -> 10 + (5 - 2) = 13

    const out = await resolve(caster.client, roundId);
    expect(out.brewer_id).toBe(caster.googleSub);

    expect(await modifierCache(target.roomId, target.googleSub)).toBe(5);
    expect(await modifierCache(caster.roomId, caster.googleSub)).toBe(0);
  });

  it("Spillage floors toward negative infinity for a negative target modifier", async () => {
    const [caster, target] = await Promise.all([
      signUp("spillage-neg-caster"),
      signUp("spillage-neg-target"),
    ]);
    await bumpModifier(caster, target.googleSub, -3); // floor(-3/2) = -2
    await forceHold(admin, caster.googleSub, "Spillage");

    const roundId = await openRound(caster, [target]);
    await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });

    const rows = await castRows(roundId);
    expect(rows.map((r) => ({ ek: r.effect_kind, params: r.effect_params, target: r.target_player_id }))).toEqual([
      { ek: "flat_modifier", params: { delta: 2 }, target: target.googleSub },
      { ek: "flat_modifier", params: { delta: -2 }, target: caster.googleSub },
    ]);
  });

  // ---------------------------------------------------------------------
  // Guard: these cards need a concrete target at cast time.
  // ---------------------------------------------------------------------
  it("rejects a Bes-Tea cast with no target and does not consume the card", async () => {
    const [caster, other] = await Promise.all([
      signUp("bestea-notarget-caster"),
      signUp("bestea-notarget-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Bes-Tea");

    const roundId = await openRound(caster, [other]);
    const { error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(error?.message).toContain("requires a target chosen at cast time");

    const { data: held } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("held_by_player", caster.googleSub)
      .maybeSingle();
    expect(held).toMatchObject({ location: "held", held_by_player: caster.googleSub });

    expect(await castRows(roundId)).toEqual([]);
  });

  it("rejects casting Bes-Tea on yourself", async () => {
    const [caster, other] = await Promise.all([
      signUp("bestea-self-caster"),
      signUp("bestea-self-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Bes-Tea");

    const roundId = await openRound(caster, [other]);
    const { error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: caster.googleSub,
    });
    expect(error?.message).toContain("cannot target yourself");
  });
});
