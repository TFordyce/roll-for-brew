import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Exercises the authoritative layer-0
// resolver resolve_round(uuid) (supabase/migrations/
// 0078_resolve_round_authoritative.sql, issue #305) directly: seed a round's
// rolls and Cast Log, call resolve_round(uuid), and assert the brewer it
// picks, the Resolution Trace it emits, and its idempotence. Asserts on
// externally observable outcomes only (spec section: Testing Decisions).

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
  outcome: "applied" | "no-op";
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

describe.skipIf(!hasAnonTestEnv)("resolve_round(uuid): modifier composition, brewer selection, Trace", () => {
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
   * Forces the given player to hold `donorCard` (any Action card with no
   * duration) purely to obtain a valid spell_deck_instances id, then writes
   * a spell_casts row directly with the exact effect_kind / effect_params /
   * target we want — decoupling the test from any one catalog card's
   * mechanics.
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
    },
  ) {
    const instanceId = await forceHold(admin, casterId, donorCard);
    // Return it to the deck immediately — the cast row is what matters.
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

  /** start_round + declare all others + close_round; returns the round id. */
  async function openAndCloseRound(starter: Awaited<ReturnType<typeof signUp>>, others: Awaited<ReturnType<typeof signUp>>[]) {
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

  // resolve_round / advance_round_layer are granted to `authenticated`, not
  // `service_role` — so drive them through a signed-in participant's client,
  // the same way the app does, not the RLS-bypassing admin client.
  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  it("a zero-cast round picks the lowest roll+modifier and emits an empty Trace", async () => {
    const p1 = await signUp("rr-nocast-1");
    const p2 = await signUp("rr-nocast-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 15);

    const out = await resolve(p1.client, roundId);

    expect(out).toMatchObject({
      outcome: "brewer",
      layer: 0,
      brewer_id: p1.googleSub,
      brewer_source: "default",
      cups_made: 2,
      no_modifier_gain: false,
      trace: [],
    });

    const { data: round } = await admin
      .from("rounds")
      .select("resolution_trace, status")
      .eq("id", roundId)
      .single();
    expect(round!.resolution_trace).toEqual([]);
    // resolve_round(uuid) does NOT itself flip the round to resolved.
    expect(round!.status).toBe("closed");
  });

  it("a flat_modifier cast composes into the pick and shows as a Trace step", async () => {
    const p1 = await signUp("rr-flat-1");
    const p2 = await signUp("rr-flat-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 12);
    // +10 on p1: composed total 15 now loses to p2's untouched 12.
    const castId = await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 10 },
      targetPlayerId: p1.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.outcome).toBe("brewer");
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.trace).toHaveLength(1);
    const step = out.trace[0]!;
    expect(step).toMatchObject({
      index: 0,
      display_kind: "flat_modifier",
      target_player: p1.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 10 },
      outcome: "applied",
    });
    expect(step.source_cast.cast_id).toBe(castId);
    expect(step.source_cast.card_name).toBe("Lucky Sip");
  });

  it("a modifier_multiplier scales the persistent snapshot, not the roll", async () => {
    const p1 = await signUp("rr-mult-1");
    const p2 = await signUp("rr-mult-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // p1: roll 5, snapshot 4 -> raw total 9 (would lose to p2's 8).
    await seedRoll(roundId, p1.googleSub, 5, 4);
    await seedRoll(roundId, p2.googleSub, 8, 0);
    // x0.5 on p1 -> composed 2 -> total 7 -> p1 now wins.
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "modifier_multiplier",
      effectParams: { multiplier: 0.5 },
      targetPlayerId: p1.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.trace[0]).toMatchObject({
      display_kind: "modifier_multiplier",
      before: { type: "modifier", value: 4 },
      after: { type: "modifier", value: 2 },
    });
  });

  it("set_modifier is absolute — it ignores a sibling flat effect and two sets resolve to the last by seq", async () => {
    const p1 = await signUp("rr-set-1");
    const p2 = await signUp("rr-set-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 10);
    await seedRoll(roundId, p2.googleSub, 4, 0);
    // A flat +100 AND set 3 AND set 0 on p1 (in that insert / seq order):
    // set wins over flat, and the LAST set (0) wins over the first (3).
    await seedCast(roundId, p1.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 100 },
      targetPlayerId: p1.googleSub,
    });
    await seedCast(roundId, p1.googleSub, "Milky Brew", {
      effectKind: "set_modifier",
      effectParams: { value: 3 },
      targetPlayerId: p1.googleSub,
    });
    await seedCast(roundId, p1.googleSub, "Caffeinated Focus", {
      effectKind: "set_modifier",
      effectParams: { value: 0 },
      targetPlayerId: p1.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    // p1 composed = 0 -> total 5; p2 total 4 -> p2 brews.
    expect(out.brewer_id).toBe(p2.googleSub);
    // Final step's running "after" is the composed total: 0, not 103.
    expect(out.trace.at(-1)!.after).toEqual({ type: "modifier", value: 0 });
  });

  it("lowest_gains_highest_modifier lifts the tied-lowest roller's composed modifier to the highest roller's", async () => {
    const p1 = await signUp("rr-lghm-1");
    const p2 = await signUp("rr-lghm-2");
    const p3 = await signUp("rr-lghm-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    // p1 lowest roll (2); p2 highest roll (18) with a +5 flat -> composed 5;
    // p3 rolls 3.
    await seedRoll(roundId, p1.googleSub, 2, 0);
    await seedRoll(roundId, p2.googleSub, 18, 0);
    await seedRoll(roundId, p3.googleSub, 3, 0);
    await seedCast(roundId, p2.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
    });
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p3.googleSub, "Fortune's Flavour", {
      effectKind: "lowest_gains_highest_modifier",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
    });

    const out = await resolve(p1.client, roundId);

    // Without LGHM p1 would brew on total 2. LGHM lifts p1's composed
    // modifier 0 -> 5, so p1's total becomes 7 and p3 (total 3) brews.
    expect(out.brewer_id).toBe(p3.googleSub);
    const lghmStep = out.trace.find((s) => s.display_kind === "lowest_gains_highest_modifier");
    expect(lghmStep).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 5 },
      outcome: "applied",
    });
  });

  it("tea_maker_override 'chosen' names the brewer regardless of the rolls", async () => {
    const p1 = await signUp("rr-tmo-chosen-1");
    const p2 = await signUp("rr-tmo-chosen-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5); // would brew by default
    await seedRoll(roundId, p2.googleSub, 15);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "chosen" },
      targetPlayerId: p2.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("tea_maker_override:chosen");
    expect(out.no_modifier_gain).toBe(false);
  });

  it("tea_maker_override 'highest_roll' picks the top roller", async () => {
    const p1 = await signUp("rr-tmo-hr-1");
    const p2 = await signUp("rr-tmo-hr-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 17);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "highest_roll" },
      targetPlayerId: null,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("tea_maker_override:highest_roll");
  });

  it("tea_maker_override 'highest_modifier' with no_modifier_gain picks the top persistent snapshot and suppresses the gain", async () => {
    const p1 = await signUp("rr-tmo-hm-1");
    const p2 = await signUp("rr-tmo-hm-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 8);
    await seedRoll(roundId, p2.googleSub, 5, 2);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "highest_modifier", no_modifier_gain: true },
      targetPlayerId: null,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.no_modifier_gain).toBe(true);
  });

  it("declared_number_tea_maker beats a tea_maker_override, and resolve_round only reads it (does not consume)", async () => {
    const p1 = await signUp("rr-decl-1");
    const p2 = await signUp("rr-decl-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5);
    await seedRoll(roundId, p2.googleSub, 13);

    // A competing override that would name p1.
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "chosen" },
      targetPlayerId: p1.googleSub,
    });

    // Inscribed-Saucer-style declared number 13 (p2 rolled it).
    const donor = await forceHold(admin, p1.googleSub, "Six Sugars");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", donor);
    const { data: card } = await admin.from("spell_cards").select("id").eq("name", "Six Sugars").single();
    const { data: sae, error: saeErr } = await admin
      .from("spell_active_effects")
      .insert({
        room_id: p1.roomId,
        target_player_id: p1.googleSub,
        caster_id: p1.googleSub,
        card_id: card!.id,
        effect_kind: "declared_number_tea_maker",
        effect_params: { number: 13 },
        rounds_remaining: 9999,
      })
      .select("id")
      .single();
    expect(saeErr).toBeNull();

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("declared_number");

    // resolve_round is a pure read — burning the one-shot is the
    // orchestrator's job (applyLayerOutcome), so the effect is still here
    // and a second call is identical.
    const { data: after } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("id", sae!.id);
    expect(after).toEqual([{ id: sae!.id }]);

    const again = await resolve(p1.client, roundId);
    expect(again.brewer_id).toBe(p2.googleSub);
    expect(JSON.stringify(again.trace)).toBe(JSON.stringify(out.trace));
  });

  it("a tie returns the sorted tied roster and no brewer", async () => {
    const p1 = await signUp("rr-tie-1");
    const p2 = await signUp("rr-tie-2");
    const p3 = await signUp("rr-tie-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 15);

    const out = await resolve(p1.client, roundId);

    expect(out.outcome).toBe("tie");
    expect(out.brewer_id).toBeNull();
    expect(out.tied_player_ids).toEqual([p1.googleSub, p2.googleSub].sort());
  });

  it("a tie-break reroll layer (layer > 0) bypasses all spell logic", async () => {
    const p1 = await signUp("rr-layer-1");
    const p2 = await signUp("rr-layer-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    // Tie layer 0, then advance to layer 1.
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    const { error: advErr } = await p1.client.rpc("advance_round_layer", {
      p_round_id: roundId,
      p_tied_player_ids: [p1.googleSub, p2.googleSub],
    });
    expect(advErr).toBeNull();
    await seedRoll(roundId, p1.googleSub, 7, 0, 1);
    await seedRoll(roundId, p2.googleSub, 3, 0, 1);
    // A flat effect that WOULD flip the pick if composed in.
    await seedCast(roundId, p2.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 100 },
      targetPlayerId: p2.googleSub,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.layer).toBe(1);
    expect(out.brewer_id).toBe(p2.googleSub); // bare roll 3 < 7, effect ignored
    expect(out.trace).toEqual([]);
  });

  it("is idempotent: re-running over identical inputs yields the same outcome and Trace", async () => {
    const p1 = await signUp("rr-idem-1");
    const p2 = await signUp("rr-idem-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 3);
    await seedRoll(roundId, p2.googleSub, 12);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "modifier_multiplier",
      effectParams: { multiplier: 2 },
      targetPlayerId: p1.googleSub,
    });

    const first = await resolve(p1.client, roundId);
    const second = await resolve(p1.client, roundId);

    expect(second.brewer_id).toBe(first.brewer_id);
    expect(second.outcome).toBe(first.outcome);
    expect(JSON.stringify(second.trace)).toBe(JSON.stringify(first.trace));
  });
});
