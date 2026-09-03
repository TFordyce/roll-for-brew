import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Covers issue #321 -- Tier A primitive 5,
// the "targeting skip" flag (migration 0099). Cloud of Cream drops its holder
// from highest/lowest-modifier *target selection* in resolve_round Phase 4c
// (lowest_gains_highest_modifier -- both the highest-modifier source and the
// lowest beneficiary set) and Phase 5 (tea_maker_override mode
// `highest_modifier`); the next eligible player is used. The flag never
// changes the holder's own composed modifier or the default brewer pick.
// Assertions are on externally observable outcomes only: the picked brewer,
// the emitted Resolution Trace, and the recorded active-effect row.

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
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  layer: number;
  brewer_id: string | null;
  brewer_source: string | null;
  tied_player_ids: string[] | null;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("targeting skip -- Cloud of Cream (#321)", () => {
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
  type Player = Awaited<ReturnType<typeof signUp>>;

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

  async function openAndCloseRound(starter: Player, others: Player[]) {
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

  /** Seed an unbounded `targeting_skip` active effect on `holder` (Cloud of Cream). */
  async function seedCloudOfCream(holder: Player) {
    return seedActiveEffect(admin, cleanup, {
      roomId: holder.roomId,
      targetPlayerId: holder.googleSub,
      casterId: holder.googleSub,
      cardName: "Cloud of Cream",
      effectKind: "targeting_skip",
      effectParams: {},
      roundsRemaining: null,
    });
  }

  function stepsOf(trace: TraceStep[], kind: string) {
    return trace.filter((s) => s.display_kind === kind);
  }

  // ----------------------------------------------------------------------
  // Phase 4c -- lowest_gains_highest_modifier
  // ----------------------------------------------------------------------

  it("a Cloud of Cream holder is skipped as a lowest_gains_highest_modifier beneficiary; the next-lowest roller is lifted instead", async () => {
    const p1 = await signUp("ts-lghm-ben-1");
    const p2 = await signUp("ts-lghm-ben-2");
    const p3 = await signUp("ts-lghm-ben-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    // p1 lowest roll (2) + Cloud of Cream; p2 next (4); p3 highest (18) with
    // a +6 flat -> composed 6.
    await seedRoll(roundId, p1.googleSub, 2, 0);
    await seedRoll(roundId, p2.googleSub, 4, 0);
    await seedRoll(roundId, p3.googleSub, 18, 0);
    await seedCloudOfCream(p1);
    await seedCast(roundId, p3.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 6 },
      targetPlayerId: p3.googleSub,
    });
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p3.googleSub, "Fortune's Flavour", {
      effectKind: "lowest_gains_highest_modifier",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
    });

    const out = await resolve(p1.client, roundId);

    // Without the skip p1 (roll 2) is lifted 0 -> 6 (total 8) and p2 (total 4)
    // brews. The skip drops p1, lifts p2 instead (0 -> 6, total 10), so p1
    // (still total 2) brews.
    expect(out.brewer_id).toBe(p1.googleSub);

    const skip = stepsOf(out.trace, "targeting_skip");
    expect(skip).toHaveLength(1);
    expect(skip[0]).toMatchObject({
      target_player: p1.googleSub,
      source_cast: { card_name: "Cloud of Cream", caster_player_id: p1.googleSub },
      before: { type: "status", value: "targetable" },
      after: { type: "status", value: "skipped" },
    });

    const lift = stepsOf(out.trace, "lowest_gains_highest_modifier");
    expect(lift).toHaveLength(1);
    expect(lift[0]).toMatchObject({
      target_player: p2.googleSub,
      after: { type: "modifier", value: 6 },
    });
  });

  it("a Cloud of Cream holder is skipped as the highest-modifier source; the lift value comes from the next-highest roller's composed modifier", async () => {
    const p1 = await signUp("ts-lghm-src-1");
    const p2 = await signUp("ts-lghm-src-2");
    const p3 = await signUp("ts-lghm-src-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    // p1 lowest roll (3); p2 highest roll (20) + Cloud of Cream, +9 flat ->
    // composed 9; p3 second-highest roll (15), +2 flat -> composed 2.
    await seedRoll(roundId, p1.googleSub, 3, 0);
    await seedRoll(roundId, p2.googleSub, 20, 0);
    await seedRoll(roundId, p3.googleSub, 15, 0);
    await seedCloudOfCream(p2);
    await seedCast(roundId, p2.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 9 },
      targetPlayerId: p2.googleSub,
    });
    await seedCast(roundId, p3.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 2 },
      targetPlayerId: p3.googleSub,
    });
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p3.googleSub, "Fortune's Flavour", {
      effectKind: "lowest_gains_highest_modifier",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
    });

    const out = await resolve(p1.client, roundId);

    const skip = stepsOf(out.trace, "targeting_skip");
    expect(skip).toHaveLength(1);
    expect(skip[0]).toMatchObject({ target_player: p2.googleSub });

    // The lift lands on p1 (lowest roll) but copies p3's composed 2, not the
    // skipped p2's composed 9.
    const lift = stepsOf(out.trace, "lowest_gains_highest_modifier");
    expect(lift).toHaveLength(1);
    expect(lift[0]).toMatchObject({
      target_player: p1.googleSub,
      before: { type: "modifier", value: 0 },
      after: { type: "modifier", value: 2 },
    });
    // p1 total 3 + 2 = 5; p3 total 17; p2 total 29 -> p1 brews.
    expect(out.brewer_id).toBe(p1.googleSub);
  });

  it("with no Cloud of Cream, lowest_gains_highest_modifier still lifts the tied-lowest roller (control)", async () => {
    const p1 = await signUp("ts-lghm-ctrl-1");
    const p2 = await signUp("ts-lghm-ctrl-2");
    const p3 = await signUp("ts-lghm-ctrl-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 2, 0);
    await seedRoll(roundId, p2.googleSub, 4, 0);
    await seedRoll(roundId, p3.googleSub, 18, 0);
    await seedCast(roundId, p3.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 6 },
      targetPlayerId: p3.googleSub,
    });
    const windowId = await openWindow(roundId);
    await seedCast(roundId, p3.googleSub, "Fortune's Flavour", {
      effectKind: "lowest_gains_highest_modifier",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: windowId,
    });

    const out = await resolve(p1.client, roundId);

    expect(stepsOf(out.trace, "targeting_skip")).toHaveLength(0);
    const lift = stepsOf(out.trace, "lowest_gains_highest_modifier");
    expect(lift).toHaveLength(1);
    expect(lift[0]).toMatchObject({ target_player: p1.googleSub, after: { type: "modifier", value: 6 } });
    // p1 lifted to total 8; p2 (total 4) brews.
    expect(out.brewer_id).toBe(p2.googleSub);
  });

  // ----------------------------------------------------------------------
  // Phase 5 -- tea_maker_override mode `highest_modifier`
  // ----------------------------------------------------------------------

  it("a Cloud of Cream holder is skipped by tea_maker_override 'highest_modifier'; the next-highest snapshot roller brews", async () => {
    const p1 = await signUp("ts-tmo-1");
    const p2 = await signUp("ts-tmo-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 8); // highest snapshot, but skipped
    await seedRoll(roundId, p2.googleSub, 5, 3);
    await seedCloudOfCream(p1);
    await seedCast(roundId, p1.googleSub, "Sugar Rush", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "highest_modifier" },
      targetPlayerId: null,
    });

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p2.googleSub);
    expect(out.brewer_source).toBe("tea_maker_override:highest_modifier");

    const skip = stepsOf(out.trace, "targeting_skip");
    expect(skip).toHaveLength(1);
    expect(skip[0]).toMatchObject({
      target_player: p1.googleSub,
      source_cast: { card_name: "Cloud of Cream" },
    });
  });

  // ----------------------------------------------------------------------
  // The flag is inert everywhere else
  // ----------------------------------------------------------------------

  it("the flag does not change the default lowest-roll brewer pick or emit a skip step", async () => {
    const p1 = await signUp("ts-inert-1");
    const p2 = await signUp("ts-inert-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3, 0); // lowest -> still brews
    await seedRoll(roundId, p2.googleSub, 12, 0);
    await seedCloudOfCream(p1);

    const out = await resolve(p1.client, roundId);

    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.brewer_source).toBe("default");
    expect(out.trace).toEqual([]);
  });

  // ----------------------------------------------------------------------
  // Real cast path + catalog
  // ----------------------------------------------------------------------

  it("casting Cloud of Cream on SELF records a targeting_skip active effect with rounds_remaining 2", async () => {
    const p1 = await signUp("ts-cast-1");
    const p2 = await signUp("ts-cast-2");

    const { data: roundId, error: startErr } = await p1.client.rpc("start_round");
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await p2.client.rpc("declare_in", { p_round_id: roundId });

    await forceHold(admin, p1.googleSub, "Cloud of Cream");
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const { data: effect, error } = await admin
      .from("spell_active_effects")
      .select("effect_kind, rounds_remaining, target_player_id")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "targeting_skip")
      .single();
    expect(error).toBeNull();
    expect(effect).toMatchObject({
      effect_kind: "targeting_skip",
      rounds_remaining: 2,
      target_player_id: p1.googleSub,
    });
  });

  it("the Cloud of Cream catalog row maps to one CASTER targeting_skip effect with duration 2", async () => {
    const { data: card } = await admin
      .from("spell_cards")
      .select("id, duration_rounds")
      .eq("name", "Cloud of Cream")
      .single();
    expect(card!.duration_rounds).toBe(2);

    const { data: effects } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params")
      .eq("card_id", card!.id);
    expect(effects).toEqual([
      { target_role: "CASTER", effect_kind: "targeting_skip", effect_params: {} },
    ]);
  });
});
