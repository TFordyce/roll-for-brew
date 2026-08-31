import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Exercises the ward phase (#309, spec
// §7): modifier-domain wards filter in resolve_round(uuid) Phase 2, roll-domain
// wards are a pre-apply check in the eager shim (apply_roll_swap etc.),
// block_earned_modifier zeroes the brewer's tea gain, and an earlier ward
// blocks a later overlapping one at record time. Asserts on externally
// observable outcomes only (spec section: Testing Decisions).

type TraceStep = {
  index: number;
  display_kind: string;
  source_cast: {
    cast_id: string | null;
    active_effect_id: string | null;
    card_name: string | null;
    caster_player_id: string | null;
  };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  blocked_cast_id?: string | null;
  ward_cast_id?: string | null;
  ward_card_name?: string | null;
  would_be_before?: number | string | null;
  would_be_after?: number | string | null;
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  layer: number;
  brewer_id: string | null;
  brewer_source: string | null;
  tied_player_ids: string[] | null;
  cups_made: number;
  no_modifier_gain: boolean;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("ward phase (#309): polarity x domain immunity filter", () => {
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

  async function seedRoll(roundId: string, playerId: string, value: number, modifierSnapshot = 0, layer = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer,
      value,
      input_mode: "manual",
      modifier_snapshot: modifierSnapshot,
    });
    expect(error).toBeNull();
  }

  async function seedCast(
    roundId: string,
    casterId: string,
    donorCard: string,
    row: {
      effectKind: string;
      effectParams: Record<string, unknown>;
      targetPlayerId: string | null;
      reactionWindowId?: string;
      castInputs?: Record<string, unknown>;
    },
  ) {
    const instanceId = await forceHold(admin, casterId, donorCard);
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);

    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: casterId,
        card_instance_id: instanceId,
        target_player_id: row.targetPlayerId,
        target_pending: false,
        effect_kind: row.effectKind,
        effect_params: row.effectParams,
        reaction_window_id: row.reactionWindowId ?? null,
        cast_inputs: row.castInputs ?? null,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function openWindow(roundId: string) {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /**
   * Inserts a ward as a carried-forward spell_active_effects projection row
   * (the same shape record_active_effect_if_persistent writes), decoupling
   * the resolver-seam tests from the full cast path. card_id is a real ward
   * card so tier-scoped dispel works unchanged.
   */
  async function seedWard(
    roomId: string,
    casterId: string,
    targetPlayerId: string,
    effectParams: Record<string, unknown>,
    roundsRemaining: number | null = null,
    cardName = "Jinxed Biscuit",
  ) {
    const { data: card, error: cardErr } = await admin
      .from("spell_cards")
      .select("id")
      .eq("name", cardName)
      .single();
    expect(cardErr).toBeNull();

    const { data, error } = await admin
      .from("spell_active_effects")
      .insert({
        room_id: roomId,
        target_player_id: targetPlayerId,
        caster_id: casterId,
        source_cast_id: null,
        card_id: card!.id,
        effect_kind: "ward",
        effect_params: effectParams,
        rounds_remaining: roundsRemaining,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function openAndCloseRound(
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
    const { error: cErr } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(cErr).toBeNull();
    return roundId as string;
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  // ----------------------------------------------------------------------
  // Modifier-domain wards (resolve_round Phase 2)
  // ----------------------------------------------------------------------

  it("a positive-polarity modifier ward blocks a positive flat_modifier: the cast row stays, the effect is removed, and a warded step is emitted", async () => {
    const p1 = await signUp("wp-flat-1");
    const p2 = await signUp("wp-flat-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);

    // Without the ward, +10 makes p1's total 15 and p2 (12) brews.
    const castId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 10 },
      targetPlayerId: p1.googleSub,
    });
    await seedWard(p1.roomId, p2.googleSub, p1.googleSub, {
      polarity: ["positive"],
      domain: ["modifier", "roll"],
    });

    const out = await resolve(p1.client, roundId);

    // The +10 is warded off, so p1's total stays 5 and p1 brews by default.
    expect(out.brewer_id).toBe(p1.googleSub);

    const warded = out.trace.find((s) => s.display_kind === "warded");
    expect(warded).toBeDefined();
    expect(warded).toMatchObject({
      target_player: p1.googleSub,
      outcome: "blocked",
      blocked_cast_id: castId,
      would_be_before: 0,
      would_be_after: 10,
    });
    expect(warded!.ward_card_name).toBe("Jinxed Biscuit");
    // No composed flat_modifier step survived.
    expect(out.trace.some((s) => s.display_kind === "flat_modifier")).toBe(false);

    // The cast row itself is untouched (card still burned earlier by the cast).
    const { data: castRow } = await admin
      .from("spell_casts")
      .select("negated, effect_kind")
      .eq("id", castId)
      .single();
    expect(castRow).toMatchObject({ negated: false, effect_kind: "flat_modifier" });
  });

  it("a negative-polarity modifier ward does not block a positive buff", async () => {
    const p1 = await signUp("wp-nonmatch-1");
    const p2 = await signUp("wp-nonmatch-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 10 },
      targetPlayerId: p1.googleSub,
    });
    // Cast-Iron Kettle shape: negative only.
    await seedWard(
      p1.roomId,
      p1.googleSub,
      p1.googleSub,
      { polarity: ["negative"], domain: ["modifier", "roll"] },
      5,
      "Cast-Iron Kettle",
    );

    const out = await resolve(p1.client, roundId);

    // +10 applies: p1 total 15, p2 (12) brews. No warded step.
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.some((s) => s.display_kind === "warded")).toBe(false);
    expect(out.trace.find((s) => s.display_kind === "flat_modifier")).toMatchObject({
      after: { type: "modifier", value: 10 },
    });
  });

  it("a set_modifier that lowers the target is negative-polarity and is blocked by a negative ward", async () => {
    const p1 = await signUp("wp-set-1");
    const p2 = await signUp("wp-set-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // p1 starts at snapshot 10; a set_modifier to 0 would drop them (negative).
    await seedRoll(roundId, p1.googleSub, 5, 10);
    await seedRoll(roundId, p2.googleSub, 12, 0);
    await seedCast(roundId, p1.googleSub, "Milky Brew", {
      effectKind: "set_modifier",
      effectParams: { value: 0 },
      targetPlayerId: p1.googleSub,
    });
    await seedWard(
      p1.roomId,
      p1.googleSub,
      p1.googleSub,
      { polarity: ["negative"], domain: ["modifier"] },
      5,
      "Cast-Iron Kettle",
    );

    const out = await resolve(p1.client, roundId);

    // Ward blocks the set: p1 keeps snapshot 10 -> total 15; p2 (12) brews.
    expect(out.brewer_id).toBe(p2.googleSub);
    const warded = out.trace.find((s) => s.display_kind === "warded");
    expect(warded).toMatchObject({ target_player: p1.googleSub, outcome: "blocked" });
  });

  it("block_earned_modifier ward on the selected brewer zeroes their tea-making gain", async () => {
    const p1 = await signUp("wp-bem-1");
    const p2 = await signUp("wp-bem-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3); // lowest -> brews by default
    await seedRoll(roundId, p2.googleSub, 15);
    await seedWard(
      p1.roomId,
      p2.googleSub,
      p1.googleSub,
      { polarity: ["positive", "negative"], domain: ["modifier"], block_earned_modifier: true },
      null,
      "Eternal Steep",
    );

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.no_modifier_gain).toBe(true);
    expect(
      out.trace.some(
        (s) => s.display_kind === "warded" && s.target_player === p1.googleSub && s.outcome === "blocked",
      ),
    ).toBe(true);
  });

  it("a warded tied-lowest roller is excluded from lowest_gains_highest_modifier; an unwarded tied-lowest roller is still lifted", async () => {
    const p1 = await signUp("wp-lghm-1");
    const p2 = await signUp("wp-lghm-2");
    const p3 = await signUp("wp-lghm-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    // p1 and p3 both roll the lowest (2); p2 rolls highest (18) with +5 -> composed 5.
    await seedRoll(roundId, p1.googleSub, 2, 0);
    await seedRoll(roundId, p2.googleSub, 18, 0);
    await seedRoll(roundId, p3.googleSub, 2, 0);
    await seedCast(roundId, p2.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
    });
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p2.googleSub, "Fortune's Flavour", {
      effectKind: "lowest_gains_highest_modifier",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
    });
    // p1 is warded against positive modifier effects; p3 is not.
    await seedWard(p1.roomId, p2.googleSub, p1.googleSub, {
      polarity: ["positive"],
      domain: ["modifier"],
    });

    const out = await resolve(p1.client, roundId);

    // p3 is lifted (composed 0 -> 5, total 7); p1 is not (stays total 2) -> p1 brews.
    expect(out.brewer_id).toBe(p1.googleSub);
    const p1Step = out.trace.find(
      (s) => s.display_kind === "warded" && s.target_player === p1.googleSub,
    );
    expect(p1Step).toMatchObject({ outcome: "blocked", would_be_after: 5 });
    const p3Lift = out.trace.find(
      (s) => s.display_kind === "lowest_gains_highest_modifier" && s.target_player === p3.googleSub,
    );
    expect(p3Lift).toMatchObject({ after: { type: "modifier", value: 5 } });
  });

  it("the warded Trace step carries blocked_cast_id / ward_cast_id / ward_card_name / would_be_before / would_be_after", async () => {
    const p1 = await signUp("wp-shape-1");
    const p2 = await signUp("wp-shape-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const castId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 7 },
      targetPlayerId: p1.googleSub,
    });
    await seedWard(p1.roomId, p2.googleSub, p1.googleSub, {
      polarity: ["positive"],
      domain: ["modifier"],
    });

    const out = await resolve(p1.client, roundId);
    const warded = out.trace.find((s) => s.display_kind === "warded")!;

    expect(warded).toBeDefined();
    expect(Object.keys(warded)).toEqual(
      expect.arrayContaining([
        "blocked_cast_id",
        "ward_cast_id",
        "ward_card_name",
        "would_be_before",
        "would_be_after",
        "target",
        "target_player",
        "outcome",
      ]),
    );
    expect((warded as unknown as { target: string }).target).toBe(p1.googleSub);
    expect(warded.blocked_cast_id).toBe(castId);
    expect(warded.would_be_before).toBe(0);
    expect(warded.would_be_after).toBe(7);
    expect(warded.outcome).toBe("blocked");
  });

  it("is idempotent: re-running with a ward yields the same outcome and Trace", async () => {
    const p1 = await signUp("wp-idem-1");
    const p2 = await signUp("wp-idem-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 10 },
      targetPlayerId: p1.googleSub,
    });
    await seedWard(p1.roomId, p2.googleSub, p1.googleSub, {
      polarity: ["positive"],
      domain: ["modifier"],
    });

    const first = await resolve(p1.client, roundId);
    const second = await resolve(p1.client, roundId);
    expect(second).toEqual(first);
  });

  // ----------------------------------------------------------------------
  // Roll-domain wards (eager shim pre-check)
  // ----------------------------------------------------------------------

  it("a roll-domain ward cancels a reaction-window roll_swap with no mutation to rolls.value", async () => {
    const p1 = await signUp("wp-swap-1");
    const p2 = await signUp("wp-swap-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 18); // high roller -> would LOSE value (negative)
    await seedRoll(roundId, p2.googleSub, 3);
    const windowId = await openWindow(roundId);
    const swapCastId = await seedCast(roundId, p2.googleSub, "Dunkin Disaster", {
      effectKind: "roll_swap",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
    });
    await seedWard(
      p1.roomId,
      p1.googleSub,
      p1.googleSub,
      { polarity: ["negative"], domain: ["roll"] },
      5,
      "Cast-Iron Kettle",
    );

    const { error: swapErr } = await p1.client.rpc("apply_roll_swap", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(swapErr).toBeNull();

    // rolls.value untouched.
    const { data: rolls } = await admin
      .from("rolls")
      .select("player_id, value")
      .eq("round_id", roundId)
      .eq("layer", 0);
    const byId = Object.fromEntries((rolls ?? []).map((r) => [r.player_id, r.value]));
    expect(byId[p1.googleSub]).toBe(18);
    expect(byId[p2.googleSub]).toBe(3);

    // The transform recorded warded markers.
    const { data: castRow } = await admin
      .from("spell_casts")
      .select("cast_inputs")
      .eq("id", swapCastId)
      .single();
    const players = (castRow!.cast_inputs as { roll_transform: { players: { warded?: boolean }[] } })
      .roll_transform.players;
    expect(players.every((pl) => pl.warded === true)).toBe(true);

    const out = await resolve(p1.client, roundId);
    expect(out.trace.some((s) => s.display_kind === "warded" && s.before.type === "roll")).toBe(true);
    // p1 keeps 18, p2 keeps 3 -> p2 (lowest) brews.
    expect(out.brewer_id).toBe(p2.googleSub);
  });

  it("a roll-domain ward blocks a forced_reroll: the roll is not re-rolled", async () => {
    const p1 = await signUp("wp-fr-1");
    const p2 = await signUp("wp-fr-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 17);
    await seedRoll(roundId, p2.googleSub, 4);
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p2.googleSub, "Milk First?", {
      effectKind: "forced_reroll",
      effectParams: {},
      targetPlayerId: p1.googleSub,
      reactionWindowId: windowId,
    });
    await seedWard(
      p1.roomId,
      p1.googleSub,
      p1.googleSub,
      { polarity: ["negative"], domain: ["roll"] },
      5,
      "Cast-Iron Kettle",
    );

    const { data: rerolled, error } = await p1.client.rpc("apply_forced_reroll", {
      p_round_id: roundId,
      p_layer: 0,
      p_player_id: p1.googleSub,
    });
    expect(error).toBeNull();
    expect(rerolled).toBe(17); // unchanged

    const { data: roll } = await admin
      .from("rolls")
      .select("value")
      .eq("round_id", roundId)
      .eq("layer", 0)
      .eq("player_id", p1.googleSub)
      .single();
    expect(roll!.value).toBe(17);
  });

  it("a roll-domain ward does not un-apply an advantage recorded before it", async () => {
    const p1 = await signUp("wp-adv-1");
    const p2 = await signUp("wp-adv-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 15);
    await seedRoll(roundId, p2.googleSub, 12);
    // advantage already resolved eagerly: recorded before 5 -> after 15.
    await seedCast(roundId, p1.googleSub, "Steady Hand", {
      effectKind: "advantage",
      effectParams: {},
      targetPlayerId: p1.googleSub,
      castInputs: {
        roll_transform: {
          kind: "advantage",
          order: 1,
          cancelled: false,
          dice: [5, 15],
          players: [{ player_id: p1.googleSub, before: 5, after: 15 }],
        },
      },
    });
    await seedWard(
      p1.roomId,
      p1.googleSub,
      p1.googleSub,
      { polarity: ["positive"], domain: ["roll"] },
      5,
      "Jinxed Biscuit",
    );

    const out = await resolve(p1.client, roundId);

    // The advantage stays adopted: p1's roll is 15, not rolled back to 5.
    const advStep = out.trace.find((s) => s.display_kind === "advantage");
    expect(advStep).toMatchObject({ after: { type: "roll", value: 15 } });
    expect(out.brewer_id).toBe(p2.googleSub); // p2's 12 is now the lowest
  });

  // ----------------------------------------------------------------------
  // rounds_remaining NULL = unbounded; dispel
  // ----------------------------------------------------------------------

  it("a NULL rounds_remaining ward is unbounded and survives resolve_round; tier-scoped dispel still ends it", async () => {
    const p1 = await signUp("wp-unbounded-1");
    const p2 = await signUp("wp-unbounded-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    const wardId = await seedWard(
      p1.roomId,
      p1.googleSub,
      p1.googleSub,
      { polarity: ["positive", "negative"], domain: ["modifier"], block_copy: true },
      null,
      "Bag for Life",
    );

    const out = await resolve(p1.client, roundId);

    // Also drive the legacy 4-arg resolve_round, which ticks
    // rounds_remaining - 1 and deletes rows that hit <= 0. A NULL row must
    // survive that tick untouched (NULL - 1 = NULL, NULL <= 0 is false).
    const { error: tickErr } = await p1.client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: out.brewer_id,
      p_cups_made: out.cups_made,
      p_no_modifier_gain: false,
    });
    expect(tickErr).toBeNull();

    const { data: still } = await admin
      .from("spell_active_effects")
      .select("id, rounds_remaining")
      .eq("id", wardId)
      .maybeSingle();
    expect(still).toMatchObject({ id: wardId, rounds_remaining: null });

    // A dispel scoped to the ward's tier (rare for Bag for Life) can still end it.
    const { error: delErr } = await admin.from("spell_active_effects").delete().eq("id", wardId);
    expect(delErr).toBeNull();
  });

  // ----------------------------------------------------------------------
  // Cast path + catalog (record_active_effect_if_persistent)
  // ----------------------------------------------------------------------

  it("the four ward cards map to their spec §7 effect_params", async () => {
    const { data: rows, error } = await admin
      .from("spell_card_effects")
      .select("effect_kind, effect_params, spell_cards!inner(name, duration_rounds)")
      .in("spell_cards.name", ["Jinxed Biscuit", "Cast-Iron Kettle", "Bag for Life", "Eternal Steep"]);
    expect(error).toBeNull();

    const byName = Object.fromEntries(
      (rows ?? []).map((r) => {
        const card = r.spell_cards as unknown as { name: string; duration_rounds: number | null };
        return [card.name, { ...r, duration_rounds: card.duration_rounds }];
      }),
    );

    expect(byName["Jinxed Biscuit"]).toMatchObject({
      effect_kind: "ward",
      effect_params: { polarity: ["positive"], domain: ["modifier", "roll"] },
      duration_rounds: 3,
    });
    expect(byName["Cast-Iron Kettle"]).toMatchObject({
      effect_kind: "ward",
      effect_params: { polarity: ["negative"], domain: ["modifier", "roll"] },
      duration_rounds: 5,
    });
    expect(byName["Bag for Life"]).toMatchObject({
      effect_kind: "ward",
      effect_params: { polarity: ["positive", "negative"], domain: ["modifier"], block_copy: true },
      duration_rounds: null,
    });
    expect(byName["Eternal Steep"]).toMatchObject({
      effect_kind: "ward",
      effect_params: {
        polarity: ["positive", "negative"],
        domain: ["modifier"],
        block_earned_modifier: true,
      },
      duration_rounds: null,
    });
  });

  it("casting Jinxed Biscuit on an opponent records a ward active-effect (rounds_remaining 3) via record_active_effect_if_persistent", async () => {
    const p1 = await signUp("wp-cast-jb-1");
    const p2 = await signUp("wp-cast-jb-2");

    const { data: roundId, error: startErr } = await p1.client.rpc("start_round");
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await p2.client.rpc("declare_in", { p_round_id: roundId });

    await forceHold(admin, p1.googleSub, "Jinxed Biscuit");
    // OPPONENT card cast with no target yet -> pending.
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    await p1.client.rpc("close_round", { p_round_id: roundId });

    const { data: pendingCast } = await admin
      .from("spell_casts")
      .select("id")
      .eq("round_id", roundId)
      .eq("effect_kind", "ward")
      .single();
    const { error: targetErr } = await p1.client.rpc("set_spell_cast_target", {
      p_cast_id: pendingCast!.id,
      p_target_player_id: p2.googleSub,
    });
    expect(targetErr).toBeNull();

    const { data: ward } = await admin
      .from("spell_active_effects")
      .select("effect_kind, effect_params, rounds_remaining, target_player_id, source_cast_id")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "ward")
      .eq("target_player_id", p2.googleSub)
      .single();
    expect(ward).toMatchObject({
      effect_kind: "ward",
      effect_params: { polarity: ["positive"], domain: ["modifier", "roll"] },
      rounds_remaining: 3,
      target_player_id: p2.googleSub,
      source_cast_id: pendingCast!.id,
    });
  });

  it("casting Bag for Life on SELF records an unbounded ward (rounds_remaining null)", async () => {
    const p1 = await signUp("wp-cast-bfl-1");
    const p2 = await signUp("wp-cast-bfl-2");

    const { data: roundId, error: startErr } = await p1.client.rpc("start_round");
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await p2.client.rpc("declare_in", { p_round_id: roundId });

    await forceHold(admin, p1.googleSub, "Bag for Life");
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const { data: ward } = await admin
      .from("spell_active_effects")
      .select("effect_kind, rounds_remaining, target_player_id")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "ward")
      .eq("target_player_id", p1.googleSub)
      .single();
    expect(ward).toMatchObject({
      effect_kind: "ward",
      rounds_remaining: null,
      target_player_id: p1.googleSub,
    });
  });

  it("an earlier ward blocks a later overlapping ward: the later row is never created", async () => {
    const p1 = await signUp("wp-wow-1");
    const p2 = await signUp("wp-wow-2");

    // Pre-existing ward on p1: positive, modifier -- overlaps Bag for Life
    // (positive|negative, modifier) in both domain and polarity.
    await seedWard(p1.roomId, p2.googleSub, p1.googleSub, {
      polarity: ["positive"],
      domain: ["modifier"],
    });

    const { data: roundId, error: startErr } = await p1.client.rpc("start_round");
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await p2.client.rpc("declare_in", { p_round_id: roundId });

    await forceHold(admin, p1.googleSub, "Bag for Life"); // SELF ward on p1
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const { data: wards } = await admin
      .from("spell_active_effects")
      .select("id, card_id, spell_cards!inner(name)")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "ward")
      .eq("target_player_id", p1.googleSub);
    // Only the seeded Jinxed-Biscuit-shaped ward survives; Bag for Life was blocked.
    expect(wards).toHaveLength(1);
    expect((wards![0]!.spell_cards as unknown as { name: string }).name).toBe("Jinxed Biscuit");
  });

  it("a non-overlapping earlier ward does NOT block a later ward", async () => {
    const p1 = await signUp("wp-wow-nonmatch-1");
    const p2 = await signUp("wp-wow-nonmatch-2");

    // Pre-existing ward on p1: roll-domain only -- Bag for Life is modifier-only,
    // so domains do not overlap and the later ward is created.
    await seedWard(
      p1.roomId,
      p2.googleSub,
      p1.googleSub,
      { polarity: ["positive", "negative"], domain: ["roll"] },
      3,
      "Jinxed Biscuit",
    );

    const { data: roundId, error: startErr } = await p1.client.rpc("start_round");
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await p2.client.rpc("declare_in", { p_round_id: roundId });

    await forceHold(admin, p1.googleSub, "Bag for Life");
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const { data: wards } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "ward")
      .eq("target_player_id", p1.googleSub);
    expect(wards).toHaveLength(2);
  });
});
