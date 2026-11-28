import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
  declareInAs,
  startRoundAs,
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

  /** start_round + everyone else declares in; returns the still-open round id. */
  async function openRound(
    starter: Awaited<ReturnType<typeof signUp>>,
    others: Awaited<ReturnType<typeof signUp>>[],
  ) {
    const { data: roundId, error } = await startRoundAs(starter.client);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await declareInAs(o.client, roundId);
      expect(dErr).toBeNull();
    }
    return roundId as string;
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
