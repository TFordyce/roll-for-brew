import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Issue #313 — the regression net ADR 0005 demands before any new-primitive
// work: every one of the 29 currently-working catalog cards pinned to an
// externally observable resolved-round outcome, run green through the new
// authoritative resolver (resolve_round(uuid), migrations 0078-0082).
//
// Each card is driven through the same seam resolve-round.test.ts uses:
// seed a closed round's rolls + a Cast Log row carrying the card's real
// spell_card_effects (effect_kind / effect_params), plus cast_inputs where a
// server-RNG draw or eager-shim before->after would have been recorded, then
// call resolve_round(uuid) and assert the brewer it picks and the Resolution
// Trace step the effect produces. Cards whose observable outcome does not
// flow through resolve_round (dispel via end_active_effect; the six WILD
// branches' cast-time dispatch) are driven through their real RPC instead.
//
// Assertions are on externally observable outcomes only — brewer, brewer
// source, adopted roll values in the Trace, spell_casts.negated, active
// effect removal, room_players.modifier after a cast-time dispatch — never on
// private helper shapes (spec: Testing Decisions).

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
  negated?: boolean;
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

describe.skipIf(!hasAnonTestEnv)("issue #313 regression net: 29 working cards through resolve_round", () => {
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

  /**
   * Force the caster to hold `donorCard` (to obtain a valid
   * spell_deck_instances id), return it to the deck, then write a spell_casts
   * row carrying the exact effect_kind / effect_params / cast_inputs we want.
   * Using the card's own name as its donor keeps the Trace's card_name
   * assertion meaningful.
   */
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
      parentCastId?: string;
      cardInstanceId?: string;
    },
  ): Promise<{ castId: string; cardInstanceId: string }> {
    let instanceId = row.cardInstanceId;
    if (!instanceId) {
      instanceId = await forceHold(admin, casterId, donorCard);
      await admin
        .from("spell_deck_instances")
        .update({ location: "in_deck", held_by_player: null })
        .eq("id", instanceId);
    }

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
        parent_cast_id: row.parentCastId ?? null,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return { castId: data!.id as string, cardInstanceId: instanceId! };
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

  /** A recorded eager-shim before->after for one player, as the shim writes it. */
  function rollTransform(
    kind: string,
    order: number,
    players: { player_id: string; before: number; after: number }[],
    extra: Record<string, unknown> = {},
  ) {
    return { roll_transform: { kind, order, players, ...extra } };
  }

  // ====================================================================
  // flat_modifier — Lucky Sip, Caffeinated Focus, Brewer's Blessing,
  // Scalding Pour, Kettle Storm
  // ====================================================================

  describe("flat_modifier", () => {
    async function flatCase(
      label: string,
      card: string,
      delta: number,
      p1Roll: number,
      p2Roll: number,
      debuffTarget: "self" | "opp",
    ) {
      const p1 = await signUp(`${label}-1`);
      const p2 = await signUp(`${label}-2`);
      const roundId = await openAndCloseRound(p1, [p2]);
      await seedRoll(roundId, p1.googleSub, p1Roll);
      await seedRoll(roundId, p2.googleSub, p2Roll);
      const target = debuffTarget === "self" ? p1.googleSub : p2.googleSub;
      const { castId } = await seedCast(roundId, p1.googleSub, card, {
        effectKind: "flat_modifier",
        effectParams: { delta },
        targetPlayerId: target,
      });

      const out = await resolve(p1.client, roundId);
      const step = out.trace.find((s) => s.display_kind === "flat_modifier");
      expect(step).toMatchObject({
        target_player: target,
        before: { type: "modifier", value: 0 },
        after: { type: "modifier", value: delta },
        outcome: "applied",
      });
      expect(step!.source_cast.cast_id).toBe(castId);
      expect(step!.source_cast.card_name).toBe(card);
      return { out, p1, p2 };
    }

    it("Lucky Sip (+3 self) pushes the caster's total past the other roller", async () => {
      // p1 bare 10 would brew; +3 -> 13 hands it to p2 (12).
      const { out, p2 } = await flatCase("reg-lucky-sip", "Lucky Sip", 3, 10, 12, "self");
      expect(out.brewer_id).toBe(p2.googleSub);
    });

    it("Caffeinated Focus (+5 self) hands the brew to the other roller", async () => {
      const { out, p2 } = await flatCase("reg-caff-focus", "Caffeinated Focus", 5, 8, 12, "self");
      expect(out.brewer_id).toBe(p2.googleSub);
    });

    it("Brewer's Blessing (+5 self) hands the brew to the other roller", async () => {
      const { out, p2 } = await flatCase("reg-brew-bless", "Brewer's Blessing", 5, 9, 13, "self");
      expect(out.brewer_id).toBe(p2.googleSub);
    });

    it("Scalding Pour (-3 opponent) drags the target's total below the caster's", async () => {
      // p1 bare 6 would brew; -3 on p2 -> p2 total 5 brews.
      const { out, p2 } = await flatCase("reg-scald-pour", "Scalding Pour", -3, 6, 8, "opp");
      expect(out.brewer_id).toBe(p2.googleSub);
    });

    it("Kettle Storm (-8 opponent) drags the target's total below the caster's", async () => {
      const { out, p2 } = await flatCase("reg-kettle-storm", "Kettle Storm", -8, 6, 12, "opp");
      expect(out.brewer_id).toBe(p2.googleSub);
    });
  });

  // ====================================================================
  // set_modifier — Milky Brew, Mug Shot, Boil Over, Caffeine Crash
  // ====================================================================

  describe("set_modifier", () => {
    it("Milky Brew (set 0 self) wipes the caster's persistent snapshot for the round", async () => {
      const p1 = await signUp("reg-milky-brew-1");
      const p2 = await signUp("reg-milky-brew-2");
      const roundId = await openAndCloseRound(p1, [p2]);
      // p1 roll 5 + snapshot 10 = 15 loses to p2 (12); set 0 -> total 5 wins.
      await seedRoll(roundId, p1.googleSub, 5, 10);
      await seedRoll(roundId, p2.googleSub, 12);
      await seedCast(roundId, p1.googleSub, "Milky Brew", {
        effectKind: "set_modifier",
        effectParams: { value: 0 },
        targetPlayerId: p1.googleSub,
      });

      const out = await resolve(p1.client, roundId);
      expect(out.brewer_id).toBe(p1.googleSub);
      expect(out.trace.find((s) => s.display_kind === "set_modifier")).toMatchObject({
        target_player: p1.googleSub,
        after: { type: "modifier", value: 0 },
      });
    });

    it("Mug Shot (set 0 opponent) wipes the target's persistent snapshot for the round", async () => {
      const p1 = await signUp("reg-mug-shot-1");
      const p2 = await signUp("reg-mug-shot-2");
      const roundId = await openAndCloseRound(p1, [p2]);
      // p2 roll 5 + snapshot 10 = 15 loses to p1 (12); set 0 -> p2 total 5 brews.
      await seedRoll(roundId, p1.googleSub, 12);
      await seedRoll(roundId, p2.googleSub, 5, 10);
      await seedCast(roundId, p1.googleSub, "Mug Shot", {
        effectKind: "set_modifier",
        effectParams: { value: 0 },
        targetPlayerId: p2.googleSub,
      });

      const out = await resolve(p1.client, roundId);
      expect(out.brewer_id).toBe(p2.googleSub);
      expect(out.trace.find((s) => s.display_kind === "set_modifier")).toMatchObject({
        target_player: p2.googleSub,
        after: { type: "modifier", value: 0 },
      });
    });

    it("Boil Over (set 0 self) wipes the caster's persistent snapshot for the round", async () => {
      const p1 = await signUp("reg-boil-over-1");
      const p2 = await signUp("reg-boil-over-2");
      const roundId = await openAndCloseRound(p1, [p2]);
      await seedRoll(roundId, p1.googleSub, 5, 10);
      await seedRoll(roundId, p2.googleSub, 12);
      await seedCast(roundId, p1.googleSub, "Boil Over", {
        effectKind: "set_modifier",
        effectParams: { value: 0 },
        targetPlayerId: p1.googleSub,
      });

      const out = await resolve(p1.client, roundId);
      expect(out.brewer_id).toBe(p1.googleSub);
      expect(out.trace.find((s) => s.display_kind === "set_modifier")).toMatchObject({
        after: { type: "modifier", value: 0 },
      });
    });

    it("Caffeine Crash (set -1 self) overrides the caster's snapshot to a fixed -1", async () => {
      const p1 = await signUp("reg-caff-crash-1");
      const p2 = await signUp("reg-caff-crash-2");
      const roundId = await openAndCloseRound(p1, [p2]);
      // Caffeine Crash carries duration_rounds = 2 -> it is a persistent
      // modifier applied through spell_active_effects, not the one-shot
      // spell_casts bucket (resolve_round's lazy branch filters on
      // sc.duration_rounds is null). Seed it as an active effect.
      // p1 roll 5 + snapshot 10 = 15 loses to p2 (6); set -1 -> total 4 brews.
      await seedRoll(roundId, p1.googleSub, 5, 10);
      await seedRoll(roundId, p2.googleSub, 6);

      const { data: card } = await admin
        .from("spell_cards")
        .select("id")
        .eq("name", "Caffeine Crash")
        .single();
      const { error: saeErr } = await admin.from("spell_active_effects").insert({
        room_id: p1.roomId,
        target_player_id: p1.googleSub,
        caster_id: p1.googleSub,
        card_id: card!.id,
        effect_kind: "set_modifier",
        effect_params: { value: -1 },
        rounds_remaining: 2,
      });
      expect(saeErr).toBeNull();

      const out = await resolve(p1.client, roundId);
      expect(out.brewer_id).toBe(p1.googleSub);
      expect(out.trace.find((s) => s.display_kind === "set_modifier")).toMatchObject({
        target_player: p1.googleSub,
        after: { type: "modifier", value: -1 },
      });
    });
  });

  // ====================================================================
  // modifier_multiplier — Double Shot
  // ====================================================================

  it("Double Shot (x2 self) scales the persistent snapshot, not the roll", async () => {
    const p1 = await signUp("reg-double-shot-1");
    const p2 = await signUp("reg-double-shot-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // p1 roll 5 + snapshot 4 = 9 would brew; x2 -> modifier 8, total 13 -> p2 (12) brews.
    await seedRoll(roundId, p1.googleSub, 5, 4);
    await seedRoll(roundId, p2.googleSub, 12);
    await seedCast(roundId, p1.googleSub, "Double Shot", {
      effectKind: "modifier_multiplier",
      effectParams: { multiplier: 2 },
      targetPlayerId: p1.googleSub,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.find((s) => s.display_kind === "modifier_multiplier")).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "modifier", value: 4 },
      after: { type: "modifier", value: 8 },
    });
  });

  // ====================================================================
  // dice_modifier — Six Sugars (standalone); Cold Tea / Slipped Spoon
  // carry the second dice half in the compound section below.
  // ====================================================================

  it("Six Sugars (1d6 self) adds its recorded roll as a positive flat delta", async () => {
    const p1 = await signUp("reg-six-sugars-1");
    const p2 = await signUp("reg-six-sugars-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // p1 bare 5 would brew; recorded d6 = 6 -> total 11 -> p2 (8) brews.
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 8);
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p1.googleSub, "Six Sugars", {
      effectKind: "dice_modifier",
      effectParams: { dice: "1d6" },
      targetPlayerId: p1.googleSub,
      reactionWindowId: windowId,
      castInputs: { dice_roll: 6 },
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.find((s) => s.display_kind === "dice_modifier")).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 6 },
      outcome: "applied",
    });
  });

  // ====================================================================
  // advantage / disadvantage (eager shim, roll_transform order 1) —
  // Sugar Rush, Fortune's Flavour
  // ====================================================================

  describe("advantage (eager shim)", () => {
    async function advCase(label: string, card: string, before: number, after: number) {
      const p1 = await signUp(`${label}-1`);
      const p2 = await signUp(`${label}-2`);
      const roundId = await openAndCloseRound(p1, [p2]);
      // rolls.value left at the recorded pre-transform value; the resolver
      // adopts the shim's recorded `after`.
      await seedRoll(roundId, p1.googleSub, before);
      await seedRoll(roundId, p2.googleSub, 8);
      const windowId = await openWindow(roundId);
      await seedCast(roundId, p1.googleSub, card, {
        effectKind: "advantage",
        effectParams: {},
        targetPlayerId: p1.googleSub,
        reactionWindowId: windowId,
        castInputs: rollTransform("advantage", 1, [{ player_id: p1.googleSub, before, after }], {
          cancelled: false,
          dice: [before, after],
        }),
      });

      const out = await resolve(p1.client, roundId);
      const step = out.trace.find((s) => s.display_kind === "advantage" && s.before.type === "roll");
      expect(step).toMatchObject({
        target_player: p1.googleSub,
        before: { type: "roll", value: before },
        after: { type: "roll", value: after },
        outcome: "applied",
      });
      return { out, p1, p2 };
    }

    it("Sugar Rush (advantage self) makes the resolver adopt the kept high die", async () => {
      // p1 kept 19 (was 3) -> p2 (8) is now the lowest and brews.
      const { out, p2 } = await advCase("reg-sugar-rush", "Sugar Rush", 3, 19);
      expect(out.brewer_id).toBe(p2.googleSub);
    });

    it("Fortune's Flavour (advantage self) makes the resolver adopt the kept high die", async () => {
      const { out, p2 } = await advCase("reg-fortunes-flavour", "Fortune's Flavour", 2, 18);
      expect(out.brewer_id).toBe(p2.googleSub);
    });
  });

  // ====================================================================
  // forced_reroll (eager shim, roll_transform order 2) —
  // Double Dunk, Re-Steep, Milk First?, Tea-M Reroll
  // ====================================================================

  describe("forced_reroll (eager shim)", () => {
    async function rerollCase(label: string, card: string, before: number, after: number) {
      const p1 = await signUp(`${label}-1`);
      const p2 = await signUp(`${label}-2`);
      const roundId = await openAndCloseRound(p1, [p2]);
      await seedRoll(roundId, p1.googleSub, before);
      await seedRoll(roundId, p2.googleSub, 9);
      const windowId = await openWindow(roundId);
      await seedCast(roundId, p2.googleSub, card, {
        effectKind: "forced_reroll",
        effectParams: {},
        targetPlayerId: p1.googleSub,
        reactionWindowId: windowId,
        castInputs: rollTransform("forced_reroll", 2, [{ player_id: p1.googleSub, before, after }]),
      });

      const out = await resolve(p1.client, roundId);
      expect(out.trace.find((s) => s.display_kind === "forced_reroll")).toMatchObject({
        target_player: p1.googleSub,
        before: { type: "roll", value: before },
        after: { type: "roll", value: after },
        outcome: "applied",
      });
      // The recorded low reroll makes p1 the lowest -> p1 brews.
      expect(out.brewer_id).toBe(p1.googleSub);
    }

    it("Double Dunk forces the target's reroll and the resolver adopts it", async () => {
      await rerollCase("reg-double-dunk", "Double Dunk", 18, 2);
    });

    it("Re-Steep forces the target's reroll and the resolver adopts it", async () => {
      await rerollCase("reg-re-steep", "Re-Steep", 17, 3);
    });

    it("Milk First? forces the target's reroll and the resolver adopts it", async () => {
      await rerollCase("reg-milk-first", "Milk First?", 16, 1);
    });

    it("Tea-M Reroll forces the target's reroll and the resolver adopts it", async () => {
      await rerollCase("reg-team-reroll", "Tea-M Reroll", 15, 4);
    });
  });

  // ====================================================================
  // roll_swap / roll_flip (eager shim, order 4 / 3) —
  // Dunkin Disaster, Zariel's Fall
  // ====================================================================

  it("Dunkin Disaster (roll_swap) swaps the two rollers' values and the resolver adopts them", async () => {
    const p1 = await signUp("reg-dunkin-1");
    const p2 = await signUp("reg-dunkin-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3);
    await seedRoll(roundId, p2.googleSub, 18);
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p2.googleSub, "Dunkin Disaster", {
      effectKind: "roll_swap",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
      castInputs: rollTransform("roll_swap", 4, [
        { player_id: p1.googleSub, before: 3, after: 18 },
        { player_id: p2.googleSub, before: 18, after: 3 },
      ]),
    });

    const out = await resolve(p1.client, roundId);
    // After the swap p1 holds 18, p2 holds 3 -> p2 brews (p1 would have brewed on the bare 3).
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.find((s) => s.display_kind === "roll_swap" && s.target_player === p2.googleSub)).toMatchObject({
      before: { type: "roll", value: 18 },
      after: { type: "roll", value: 3 },
    });
  });

  it("Zariel's Fall (roll_flip) flips every roll to 21 minus its value and the resolver adopts them", async () => {
    const p1 = await signUp("reg-zariel-1");
    const p2 = await signUp("reg-zariel-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 2);
    await seedRoll(roundId, p2.googleSub, 20);
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p2.googleSub, "Zariel's Fall", {
      effectKind: "roll_flip",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
      castInputs: rollTransform("roll_flip", 3, [
        { player_id: p1.googleSub, before: 2, after: 19 },
        { player_id: p2.googleSub, before: 20, after: 1 },
      ]),
    });

    const out = await resolve(p1.client, roundId);
    // After the flip p1 holds 19, p2 holds 1 -> p2 brews (p1 would have brewed on the bare 2).
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.find((s) => s.display_kind === "roll_flip" && s.target_player === p2.googleSub)).toMatchObject({
      before: { type: "roll", value: 20 },
      after: { type: "roll", value: 1 },
    });
  });

  // ====================================================================
  // Compound cards — both effect rows of one cast group must land
  // (Cold Tea, Slipped Spoon)
  // ====================================================================

  it("Cold Tea applies both halves: -3 on the opponent and the caster's positive 1d4", async () => {
    const p1 = await signUp("reg-cold-tea-1");
    const p2 = await signUp("reg-cold-tea-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // p1 bare 5 would brew. -3 on p2 -> 4; +4 (1d4) on p1 -> 9. p2 (4) brews.
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 7);
    const { cardInstanceId } = await seedCast(roundId, p1.googleSub, "Cold Tea", {
      effectKind: "flat_modifier",
      effectParams: { delta: -3 },
      targetPlayerId: p2.googleSub,
    });
    await seedCast(roundId, p1.googleSub, "Cold Tea", {
      effectKind: "dice_modifier",
      effectParams: { dice: "1d4" },
      targetPlayerId: p1.googleSub,
      castInputs: { dice_roll: 4 },
      cardInstanceId,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.find((s) => s.display_kind === "flat_modifier" && s.target_player === p2.googleSub)).toMatchObject({
      after: { type: "modifier", value: -3 },
      outcome: "applied",
    });
    expect(out.trace.find((s) => s.display_kind === "dice_modifier" && s.target_player === p1.googleSub)).toMatchObject({
      after: { type: "modifier", value: 4 },
      outcome: "applied",
    });
  });

  it("Slipped Spoon applies both halves: disadvantage on the opponent and the caster's positive 1d4", async () => {
    const p1 = await signUp("reg-slipped-spoon-1");
    const p2 = await signUp("reg-slipped-spoon-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // p2's disadvantage low die 3 is adopted; p1 +3 (1d4) -> 8. p2 (3) brews.
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 15);
    const windowId = await openWindow(roundId);
    const { cardInstanceId } = await seedCast(roundId, p1.googleSub, "Slipped Spoon", {
      effectKind: "disadvantage",
      effectParams: {},
      targetPlayerId: p2.googleSub,
      reactionWindowId: windowId,
      castInputs: rollTransform("disadvantage", 1, [{ player_id: p2.googleSub, before: 15, after: 3 }], {
        cancelled: false,
        dice: [15, 3],
      }),
    });
    await seedCast(roundId, p1.googleSub, "Slipped Spoon", {
      effectKind: "dice_modifier",
      effectParams: { dice: "1d4" },
      targetPlayerId: p1.googleSub,
      castInputs: { dice_roll: 3 },
      cardInstanceId,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace.find((s) => s.display_kind === "disadvantage" && s.before.type === "roll")).toMatchObject({
      target_player: p2.googleSub,
      before: { type: "roll", value: 15 },
      after: { type: "roll", value: 3 },
    });
    expect(out.trace.find((s) => s.display_kind === "dice_modifier" && s.target_player === p1.googleSub)).toMatchObject({
      after: { type: "modifier", value: 3 },
    });
  });

  // ====================================================================
  // contested_negate — Tannin Tantrum (tier-derived DC from the victim card)
  // ====================================================================

  it("Tannin Tantrum negates the whole victim cast group when its d20 clears the victim card's tier DC", async () => {
    const p1 = await signUp("reg-tannin-1");
    const p2 = await signUp("reg-tannin-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    // Victim: a common-tier Lucky Sip +10 on p1 (tier DC 2). Without the
    // counter p1 -> 15 and p2 brews.
    const { castId: victimId } = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 10 },
      targetPlayerId: p1.googleSub,
    });
    await seedCast(roundId, p2.googleSub, "Tannin Tantrum", {
      effectKind: "contested_negate",
      effectParams: {},
      targetPlayerId: null,
      parentCastId: victimId,
      castInputs: { dc_d20: 5 },
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p1.googleSub);
    const { data: victim } = await admin.from("spell_casts").select("negated").eq("id", victimId).single();
    expect(victim!.negated).toBe(true);
    expect(out.trace.find((s) => s.display_kind === "contested_negate")).toMatchObject({ outcome: "applied" });
  });

  // ====================================================================
  // lowest_gains_highest_modifier — Broken Biscuit
  // ====================================================================

  it("Broken Biscuit lifts the tied-lowest roller's composed modifier to the highest roller's", async () => {
    const p1 = await signUp("reg-broken-biscuit-1");
    const p2 = await signUp("reg-broken-biscuit-2");
    const p3 = await signUp("reg-broken-biscuit-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    // p1 lowest roll (2); p2 highest roll (18) with +5 flat -> composed 5; p3 rolls 3.
    await seedRoll(roundId, p1.googleSub, 2);
    await seedRoll(roundId, p2.googleSub, 18);
    await seedRoll(roundId, p3.googleSub, 3);
    await seedCast(roundId, p2.googleSub, "Brewer's Blessing", {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
    });
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p3.googleSub, "Broken Biscuit", {
      effectKind: "lowest_gains_highest_modifier",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
    });

    const out = await resolve(p1.client, roundId);
    // p1's composed modifier 0 -> 5, total 7; p3 (3) now brews.
    expect(out.brewer_id).toBe(p3.googleSub);
    expect(out.trace.find((s) => s.display_kind === "lowest_gains_highest_modifier")).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 5 },
      outcome: "applied",
    });
  });

  // ====================================================================
  // tea_maker_override — Drip Tray (highest_modifier), Topsy-Tea (highest_roll)
  // ====================================================================

  it("Drip Tray (tea_maker_override highest_modifier) names the top persistent snapshot and suppresses the gain", async () => {
    const p1 = await signUp("reg-drip-tray-1");
    const p2 = await signUp("reg-drip-tray-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 8);
    await seedRoll(roundId, p2.googleSub, 5, 2);
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p1.googleSub, "Drip Tray", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "highest_modifier", no_modifier_gain: true },
      targetPlayerId: null,
      reactionWindowId: windowId,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.brewer_source).toBe("tea_maker_override:highest_modifier");
    expect(out.no_modifier_gain).toBe(true);
  });

  it("Topsy-Tea (tea_maker_override highest_roll) names the top roller regardless of totals", async () => {
    const p1 = await signUp("reg-topsy-tea-1");
    const p2 = await signUp("reg-topsy-tea-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 17);
    await seedCast(roundId, p1.googleSub, "Topsy-Tea", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "highest_roll" },
      targetPlayerId: null,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("tea_maker_override:highest_roll");
  });

  // ====================================================================
  // declared_number_tea_maker — Inscribed Saucer
  // ====================================================================

  it("Inscribed Saucer (declared_number_tea_maker) names the first roller matching the declared number", async () => {
    const p1 = await signUp("reg-inscribed-saucer-1");
    const p2 = await signUp("reg-inscribed-saucer-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 13);

    const instanceId = await forceHold(admin, p1.googleSub, "Inscribed Saucer");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    const { data: card } = await admin.from("spell_cards").select("id").eq("name", "Inscribed Saucer").single();
    const { error: saeErr } = await admin.from("spell_active_effects").insert({
      room_id: p1.roomId,
      target_player_id: p1.googleSub,
      caster_id: p1.googleSub,
      card_id: card!.id,
      effect_kind: "declared_number_tea_maker",
      effect_params: { number: 13 },
      rounds_remaining: 9999,
    });
    expect(saeErr).toBeNull();

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("declared_number");
  });

  // ====================================================================
  // dispel — Lesser Detox (common), Greater Detox (rare/epic).
  // Not a resolve_round path: end_active_effect removes the matching-tier
  // active effect and logs a `dispel` cast.
  // ====================================================================

  describe("dispel", () => {
    async function seedActiveEffect(roomId: string, targetId: string, casterId: string, cardName: string) {
      const { data: card } = await admin.from("spell_cards").select("id").eq("name", cardName).single();
      const { data, error } = await admin
        .from("spell_active_effects")
        .insert({
          room_id: roomId,
          target_player_id: targetId,
          caster_id: casterId,
          card_id: card!.id,
          effect_kind: "flat_modifier",
          effect_params: { delta: 3 },
          rounds_remaining: 9999,
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      return data!.id as string;
    }

    it("Lesser Detox ends a common-tier active effect and logs a dispel cast; rejects a rare-tier one", async () => {
      const caster = await signUp("reg-lesser-detox-caster");
      const target = await signUp("reg-lesser-detox-target");
      // Lucky Sip is common; Milky Brew is rare.
      const commonEffectId = await seedActiveEffect(caster.roomId, target.googleSub, caster.googleSub, "Lucky Sip");
      const rareEffectId = await seedActiveEffect(caster.roomId, target.googleSub, caster.googleSub, "Milky Brew");

      await forceHold(admin, caster.googleSub, "Lesser Detox");
      const { data: roundId, error: startErr } = await caster.client.rpc("start_round");
      expect(startErr).toBeNull();
      cleanup.trackRound(roundId as string);
      await target.client.rpc("declare_in", { p_round_id: roundId });

      const { error: rejectErr } = await caster.client.rpc("end_active_effect", {
        p_round_id: roundId,
        p_effect_id: rareEffectId,
      });
      expect(rejectErr).not.toBeNull();

      const { error: dispelErr } = await caster.client.rpc("end_active_effect", {
        p_round_id: roundId,
        p_effect_id: commonEffectId,
      });
      expect(dispelErr).toBeNull();

      const { data: remaining } = await admin
        .from("spell_active_effects")
        .select("id")
        .in("id", [commonEffectId, rareEffectId]);
      expect(remaining!.map((r) => r.id)).toEqual([rareEffectId]);

      const { data: dispelCasts } = await admin
        .from("spell_casts")
        .select("effect_kind")
        .eq("round_id", roundId)
        .eq("effect_kind", "dispel");
      expect(dispelCasts).toHaveLength(1);
    });

    it("Greater Detox ends a rare-tier active effect and logs a dispel cast; rejects a common-tier one", async () => {
      const caster = await signUp("reg-greater-detox-caster");
      const target = await signUp("reg-greater-detox-target");
      const commonEffectId = await seedActiveEffect(caster.roomId, target.googleSub, caster.googleSub, "Lucky Sip");
      const rareEffectId = await seedActiveEffect(caster.roomId, target.googleSub, caster.googleSub, "Milky Brew");

      await forceHold(admin, caster.googleSub, "Greater Detox");
      const { data: roundId, error: startErr } = await caster.client.rpc("start_round");
      expect(startErr).toBeNull();
      cleanup.trackRound(roundId as string);
      await target.client.rpc("declare_in", { p_round_id: roundId });

      const { error: rejectErr } = await caster.client.rpc("end_active_effect", {
        p_round_id: roundId,
        p_effect_id: commonEffectId,
      });
      expect(rejectErr).not.toBeNull();

      const { error: dispelErr } = await caster.client.rpc("end_active_effect", {
        p_round_id: roundId,
        p_effect_id: rareEffectId,
      });
      expect(dispelErr).toBeNull();

      const { data: remaining } = await admin
        .from("spell_active_effects")
        .select("id")
        .in("id", [commonEffectId, rareEffectId]);
      expect(remaining!.map((r) => r.id)).toEqual([commonEffectId]);

      const { data: dispelCasts } = await admin
        .from("spell_casts")
        .select("effect_kind")
        .eq("round_id", roundId)
        .eq("effect_kind", "dispel");
      expect(dispelCasts).toHaveLength(1);
    });
  });

  // ====================================================================
  // wild_dispatch — Wild Brew Surge, all six d6 branches.
  // Branches dispatch imperatively at cast time; drive the real
  // cast_spell_card RPC in a loop until every branch has been observed.
  // ====================================================================

  it("Wild Brew Surge dispatches every one of its six d6 branches to a consistent outcome", async () => {
    const caster = await signUp("reg-wbs-caster");
    const other = await signUp("reg-wbs-other");
    const { data: card } = await admin.from("spell_cards").select("id").eq("name", "Wild Brew Surge").single();
    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("id")
      .eq("card_id", card!.id)
      .single();
    const wbsInstanceId = instance!.id as string;

    const seen = new Set<number>();
    const CASTER_MOD = 7;
    const OTHER_MOD = 2;
    const MAX_ATTEMPTS = 120;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && seen.size < 6; attempt++) {
      // Fresh known modifiers for each attempt.
      await admin
        .from("room_players")
        .update({ modifier: CASTER_MOD })
        .eq("room_id", caster.roomId)
        .eq("player_id", caster.googleSub);
      await admin
        .from("room_players")
        .update({ modifier: OTHER_MOD })
        .eq("room_id", caster.roomId)
        .eq("player_id", other.googleSub);
      // Re-arm the single WBS instance into the caster's hand.
      await admin
        .from("spell_deck_instances")
        .update({ location: "held", held_by_player: caster.googleSub })
        .eq("id", wbsInstanceId);

      const { data: roundId, error: startErr } = await caster.client.rpc("start_round");
      expect(startErr).toBeNull();
      await other.client.rpc("declare_in", { p_round_id: roundId });

      const { error: castErr } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
      expect(castErr).toBeNull();

      const { data: dispatchRow } = await admin
        .from("spell_casts")
        .select("cast_inputs")
        .eq("round_id", roundId)
        .eq("effect_kind", "wild_dispatch")
        .order("cast_at", { ascending: true })
        .limit(1)
        .single();
      const branch = (dispatchRow!.cast_inputs as { branch: number }).branch;
      expect(branch).toBeGreaterThanOrEqual(1);
      expect(branch).toBeLessThanOrEqual(6);
      seen.add(branch);

      const { data: mods } = await admin
        .from("room_players")
        .select("player_id, modifier")
        .eq("room_id", caster.roomId)
        .in("player_id", [caster.googleSub, other.googleSub]);
      const modOf = (pid: string) => mods!.find((m) => m.player_id === pid)!.modifier;

      if (branch === 1) {
        // Everyone in the room reset to 0.
        expect(modOf(caster.googleSub)).toBe(0);
        expect(modOf(other.googleSub)).toBe(0);
      } else if (branch === 2) {
        // Caster gains +3 rest of day.
        expect(modOf(caster.googleSub)).toBe(CASTER_MOD + 3);
        expect(modOf(other.googleSub)).toBe(OTHER_MOD);
      } else if (branch === 3) {
        // Caster <-> the one other room player: modifiers swapped.
        expect(modOf(caster.googleSub)).toBe(OTHER_MOD);
        expect(modOf(other.googleSub)).toBe(CASTER_MOD);
      } else if (branch === 4) {
        // Arms a table-wide forced_reroll placeholder for the resolver's roll phase.
        const { data: placeholder } = await admin
          .from("spell_casts")
          .select("target_role, target_pending")
          .eq("round_id", roundId)
          .eq("effect_kind", "forced_reroll");
        expect(placeholder).toHaveLength(1);
        expect(placeholder![0]).toMatchObject({ target_role: "TABLE", target_pending: true });
        expect(modOf(caster.googleSub)).toBe(CASTER_MOD);
      } else if (branch === 5) {
        // Highest and lowest room modifiers swapped (caster 7 <-> other 2).
        expect(modOf(caster.googleSub)).toBe(OTHER_MOD);
        expect(modOf(other.googleSub)).toBe(CASTER_MOD);
      } else {
        // Branch 6: arms a tea_maker_override 'chosen' cast for the resolver's brewer phase.
        const { data: override } = await admin
          .from("spell_casts")
          .select("effect_params")
          .eq("round_id", roundId)
          .eq("effect_kind", "tea_maker_override");
        expect(override).toHaveLength(1);
        expect((override![0]!.effect_params as { mode: string }).mode).toBe("chosen");
        expect(modOf(caster.googleSub)).toBe(CASTER_MOD);
      }

      // Free the room for the next attempt.
      await admin.from("rounds").delete().eq("id", roundId);
    }

    // Restore the WBS instance to the deck for cleanup.
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", wbsInstanceId);

    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
