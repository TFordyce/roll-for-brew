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

// Runs against a real Supabase stack. Issue #428 (spec #401 F2, design #381):
// brewer immunity -- a `brewer_immunity` active effect -- and its first card,
// The Last Cuppa ("You cannot be the tea-maker for the rest of the day under
// any circumstance. No card, force, mark, or curse can override this.").
//
//   * Tier 0 of the precedence ladder (ADR 0005): an immune player is no
//     match at every tier of Phase 5 -- a declared number, an override target
//     and the lowest-roller pool all skip them and fall through.
//   * Everyone immune and no override: immunity gives way to a Tie-Break
//     Reroll among all participants.
//   * The Last Cuppa's row is unbounded (`persist`) and `is_undispellable`:
//     no dispel can end it.
// Assertions are on observable outcomes: the picked brewer, the Resolution
// Trace, the recorded active-effect row, and the dispel RPCs' answers.

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
  immunity_tier?: string;
  skipped_card_name?: string | null;
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  layer: number;
  brewer_id: string | null;
  brewer_source: string | null;
  tied_player_ids: string[] | null;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("brewer immunity -- The Last Cuppa (#428)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  type Player = Awaited<ReturnType<typeof signUpSignInAndEnterRoom>>;

  /** Signs up the players into their own room so no stranger joins a round. */
  async function players<const L extends readonly string[]>(...labels: L): Promise<{ [K in keyof L]: Player }> {
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `imm-${l}`)));
    const roomId = await seedDedicatedRoom(
      admin,
      cleanup,
      ps.map((p) => p.googleSub),
    );
    return ps.map((p) => ({ ...p, roomId })) as { [K in keyof L]: Player };
  }

  async function openRound(starter: Player, others: Player[]): Promise<string> {
    const { data: roundId, error } = await starter.client.rpc("start_round", { p_room_id: starter.roomId });
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function close(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function openAndCloseRound(starter: Player, others: Player[]) {
    const roundId = await openRound(starter, others);
    await close(starter, roundId);
    return roundId;
  }

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

  /** A Cast Log row recorded straight into the table, donor instance returned to the deck. */
  async function seedCast(
    roundId: string,
    caster: Player,
    donorCard: string,
    row: { effectKind: string; effectParams?: Record<string, unknown>; targetPlayerId?: string | null },
  ) {
    const instanceId = await forceHold(admin, caster.googleSub, donorCard);
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: caster.googleSub,
        card_instance_id: instanceId,
        target_player_id: row.targetPlayerId ?? null,
        target_pending: false,
        effect_kind: row.effectKind,
        effect_params: row.effectParams ?? {},
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** The Last Cuppa, cast for real through cast_spell_card while `roundId` is open. */
  async function castLastCuppa(caster: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, "The Last Cuppa");
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  /** A live Last Cuppa immunity row on `holder`, projected from an earlier (resolved) round. */
  async function seedImmunity(holder: Player) {
    return seedActiveEffect(admin, cleanup, {
      roomId: holder.roomId,
      targetPlayerId: holder.googleSub,
      casterId: holder.googleSub,
      cardName: "The Last Cuppa",
      effectKind: "brewer_immunity",
      effectParams: { mode: "last_cuppa", persist: true, undispellable: true, override_proof: true },
      roundsRemaining: null,
    });
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  async function finalize(client: SupabaseClient, roundId: string) {
    const { error: wErr } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" });
    expect(wErr).toBeNull();
    const { data, error } = await client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { outcome: string; brewer_id?: string; layer?: number; tied_player_ids?: string[] };
  }

  async function markResolved(roundId: string) {
    const { error } = await admin
      .from("rounds")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", roundId);
    expect(error).toBeNull();
  }

  function immunitySteps(out: ResolveOutcome) {
    return out.trace.filter((s) => s.display_kind === "brewer_immunity");
  }

  // -----------------------------------------------------------------------
  // The card: un-benched, and casting it projects the immunity row.
  // -----------------------------------------------------------------------

  it("is un-benched and casting it promotes an unbounded, undispellable brewer_immunity row", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "The Last Cuppa")
      .single();
    expect(inst!.location).not.toBe("benched");

    const [caster, other] = await players("cast-a", "cast-b");
    const roundId = await openRound(caster, [other]);
    await castLastCuppa(caster, roundId);

    const { data: casts } = await admin
      .from("spell_casts")
      .select("effect_kind, target_player_id")
      .eq("round_id", roundId);
    expect(casts).toContainEqual({ effect_kind: "brewer_immunity", target_player_id: caster.googleSub });

    const { data: effects } = await admin
      .from("spell_active_effects")
      .select("effect_kind, target_player_id, rounds_remaining, is_undispellable, effect_params")
      .eq("room_id", caster.roomId)
      .eq("effect_kind", "brewer_immunity");
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      target_player_id: caster.googleSub,
      rounds_remaining: null,
      is_undispellable: true,
      effect_params: { mode: "last_cuppa" },
    });
  });

  // -----------------------------------------------------------------------
  // Tier 0 inside every tier.
  // -----------------------------------------------------------------------

  it("the lowest roller who cast it this round doesn't brew: the next-lowest does, end to end", async () => {
    const [caster, mid, high] = await players("low-a", "low-b", "low-c");
    const roundId = await openRound(caster, [mid, high]);
    await castLastCuppa(caster, roundId);
    await close(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 2);
    await seedRoll(roundId, mid.googleSub, 9);
    await seedRoll(roundId, high.googleSub, 15);

    const out = await resolve(caster.client, roundId);
    expect(out).toMatchObject({ outcome: "brewer", brewer_id: mid.googleSub, brewer_source: "default" });
    const [skip] = immunitySteps(out);
    expect(skip).toMatchObject({
      target_player: caster.googleSub,
      immunity_tier: "lowest_roller",
      skipped_card_name: null,
      before: { type: "status", value: "brewer" },
      after: { type: "status", value: "immune" },
      source_cast: { card_name: "The Last Cuppa", caster_player_id: caster.googleSub },
    });

    const fin = await finalize(caster.client, roundId);
    expect(fin).toMatchObject({ outcome: "brewer", brewer_id: mid.googleSub });
    const { data: round } = await admin.from("rounds").select("status, brewer_id").eq("id", roundId).single();
    expect(round).toMatchObject({ status: "resolved", brewer_id: mid.googleSub });
  });

  it("an immune natural 1 is skipped too", async () => {
    const [holder, other] = await players("nat1-a", "nat1-b");
    await seedImmunity(holder);
    const roundId = await openAndCloseRound(holder, [other]);
    await seedRoll(roundId, holder.googleSub, 1);
    await seedRoll(roundId, other.googleSub, 18);

    const out = await resolve(holder.client, roundId);
    expect(out.brewer_id).toBe(other.googleSub);
    expect(immunitySteps(out).map((s) => s.target_player)).toEqual([holder.googleSub]);
  });

  it("no skip step when the immune player wasn't going to brew anyway", async () => {
    const [holder, other] = await players("quiet-a", "quiet-b");
    await seedImmunity(holder);
    const roundId = await openAndCloseRound(holder, [other]);
    await seedRoll(roundId, holder.googleSub, 17);
    await seedRoll(roundId, other.googleSub, 4);

    const out = await resolve(holder.client, roundId);
    expect(out.brewer_id).toBe(other.googleSub);
    expect(immunitySteps(out)).toHaveLength(0);
  });

  it("a declared number the immune player rolled is no match; selection falls through", async () => {
    const [holder, declarer, other] = await players("decl-a", "decl-b", "decl-c");
    await seedImmunity(holder);
    const roundId = await openAndCloseRound(holder, [declarer, other]);
    // Inscribed Saucer's declared number, anchored in this round.
    await seedActiveEffect(admin, cleanup, {
      roomId: holder.roomId,
      targetPlayerId: declarer.googleSub,
      casterId: declarer.googleSub,
      cardName: "Inscribed Saucer",
      effectKind: "declared_number_tea_maker",
      effectParams: { number: 12 },
      roundsRemaining: 1,
      roundId,
    });
    await seedRoll(roundId, holder.googleSub, 12);
    await seedRoll(roundId, declarer.googleSub, 8);
    await seedRoll(roundId, other.googleSub, 15);

    const out = await resolve(holder.client, roundId);
    // Nobody else rolled 12: the default pick (lowest non-immune) brews.
    expect(out).toMatchObject({ brewer_id: declarer.googleSub, brewer_source: "default" });
    expect(immunitySteps(out)).toEqual([
      expect.objectContaining({
        target_player: holder.googleSub,
        immunity_tier: "declared_number",
        skipped_card_name: "Inscribed Saucer",
      }),
    ]);
    expect(out.trace.some((s) => s.display_kind === "declared_number_tea_maker")).toBe(false);
  });

  it("a declared number matched by an immune and a non-immune roller names the non-immune one", async () => {
    const [holder, declarer, other] = await players("decl2-a", "decl2-b", "decl2-c");
    await seedImmunity(holder);
    const roundId = await openAndCloseRound(holder, [declarer, other]);
    await seedActiveEffect(admin, cleanup, {
      roomId: holder.roomId,
      targetPlayerId: declarer.googleSub,
      casterId: declarer.googleSub,
      cardName: "Inscribed Saucer",
      effectKind: "declared_number_tea_maker",
      effectParams: { number: 12 },
      roundsRemaining: 1,
      roundId,
    });
    await seedRoll(roundId, holder.googleSub, 12);
    await seedRoll(roundId, declarer.googleSub, 3);
    await seedRoll(roundId, other.googleSub, 12);

    const out = await resolve(holder.client, roundId);
    expect(out).toMatchObject({ brewer_id: other.googleSub, brewer_source: "declared_number" });
  });

  it.each([
    ["chosen", (target: string) => ({ params: { mode: "chosen" }, target })],
    ["highest_roll", () => ({ params: { mode: "highest_roll" }, target: null })],
    ["highest_modifier", () => ({ params: { mode: "highest_modifier" }, target: null })],
  ] as const)("a %s override naming the immune player falls through to the default pick", async (mode, shape) => {
    const [holder, caster, other] = await players(`ovr-${mode}-a`, `ovr-${mode}-b`, `ovr-${mode}-c`);
    await seedImmunity(holder);
    const roundId = await openAndCloseRound(holder, [caster, other]);
    // holder has the highest roll and the highest modifier: every mode names them.
    await seedRoll(roundId, holder.googleSub, 19, 9);
    await seedRoll(roundId, caster.googleSub, 11, 1);
    await seedRoll(roundId, other.googleSub, 4, 0);
    const { params, target } = shape(holder.googleSub);
    await seedCast(roundId, caster, "Drip Tray", {
      effectKind: "tea_maker_override",
      effectParams: params,
      targetPlayerId: target,
    });

    const out = await resolve(caster.client, roundId);
    expect(out).toMatchObject({ outcome: "brewer", brewer_id: other.googleSub, brewer_source: "default" });
    expect(out.trace.some((s) => s.display_kind === "tea_maker_override")).toBe(false);
    expect(immunitySteps(out)).toEqual([
      expect.objectContaining({
        target_player: holder.googleSub,
        immunity_tier: "tea_maker_override",
        skipped_card_name: "Drip Tray",
      }),
    ]);
  });

  it("an override on someone else still lands", async () => {
    const [holder, caster, other] = await players("ovr-other-a", "ovr-other-b", "ovr-other-c");
    await seedImmunity(holder);
    const roundId = await openAndCloseRound(holder, [caster, other]);
    await seedRoll(roundId, holder.googleSub, 2);
    await seedRoll(roundId, caster.googleSub, 11);
    await seedRoll(roundId, other.googleSub, 14);
    await seedCast(roundId, caster, "Drip Tray", {
      effectKind: "tea_maker_override",
      effectParams: { mode: "chosen" },
      targetPlayerId: other.googleSub,
    });

    const out = await resolve(caster.client, roundId);
    expect(out).toMatchObject({ brewer_id: other.googleSub, brewer_source: "tea_maker_override:chosen" });
    expect(immunitySteps(out)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Everyone immune.
  // -----------------------------------------------------------------------

  it("everyone immune and no override: a Tie-Break Reroll among all participants", async () => {
    const [a, b, c] = await players("all-a", "all-b", "all-c");
    await Promise.all([seedImmunity(a), seedImmunity(b), seedImmunity(c)]);
    const roundId = await openAndCloseRound(a, [b, c]);
    await seedRoll(roundId, a.googleSub, 3);
    await seedRoll(roundId, b.googleSub, 9);
    await seedRoll(roundId, c.googleSub, 16);
    const everyone = [a.googleSub, b.googleSub, c.googleSub].sort();

    const out = await resolve(a.client, roundId);
    expect(out.outcome).toBe("tie");
    expect([...out.tied_player_ids!].sort()).toEqual(everyone);
    expect(immunitySteps(out)).toEqual([
      expect.objectContaining({
        target_player: null,
        immunity_tier: "all_immune",
        after: { type: "status", value: "tie" },
      }),
    ]);

    const fin = await finalize(a.client, roundId);
    expect(fin).toMatchObject({ outcome: "tie", layer: 1 });
    expect([...fin.tied_player_ids!].sort()).toEqual(everyone);
  });

  // -----------------------------------------------------------------------
  // Undispellable.
  // -----------------------------------------------------------------------

  it("Greater Detox can't dispel it: never offered, refused directly, and a dispel naming it is ignored", async () => {
    const [holder, detoxer] = await players("dsp-a", "dsp-b");

    // Round 1: holder casts The Last Cuppa for real (so is_undispellable is set).
    const r1 = await openRound(holder, [detoxer]);
    await castLastCuppa(holder, r1);
    await markResolved(r1);
    const { data: fx } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("room_id", holder.roomId)
      .eq("effect_kind", "brewer_immunity")
      .single();
    const effectId = fx!.id as string;

    // Round 2: the detoxer holds Greater Detox (it ends Rare or Epic effects).
    const r2 = await openRound(holder, [detoxer]);
    await forceHold(admin, detoxer.googleSub, "Greater Detox");

    const { data: offered, error: offErr } = await detoxer.client.rpc("get_dispellable_active_effects", {
      p_round_id: r2,
    });
    expect(offErr).toBeNull();
    expect((offered as { effect_id: string }[]).map((r) => r.effect_id)).not.toContain(effectId);

    const { error: endErr } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: r2,
      p_effect_id: effectId,
    });
    expect(endErr).not.toBeNull();
    expect(endErr!.message).toMatch(/cannot be dispelled/);

    // A dispel cast naming it (however it got there) doesn't end it.
    await seedCast(r2, detoxer, "Greater Detox", {
      effectKind: "dispel",
      effectParams: { ended_effect_id: effectId },
      targetPlayerId: holder.googleSub,
    });
    await close(holder, r2);
    await seedRoll(r2, holder.googleSub, 2);
    await seedRoll(r2, detoxer.googleSub, 17);
    const out = await resolve(holder.client, r2);
    expect(out.brewer_id).toBe(detoxer.googleSub);
  });

  it("a dispellable immunity row (no undispellable marker) can still be offered to Detox", async () => {
    // Control for the filter: the flag, not the kind, is what blocks dispel.
    const [holder, detoxer] = await players("dsp-ctl-a", "dsp-ctl-b");
    const { effectId } = await seedImmunity(holder); // seeded row: is_undispellable defaults false
    const r = await openRound(holder, [detoxer]);
    await forceHold(admin, detoxer.googleSub, "Greater Detox");
    const { data: offered, error } = await detoxer.client.rpc("get_dispellable_active_effects", { p_round_id: r });
    expect(error).toBeNull();
    expect((offered as { effect_id: string }[]).map((x) => x.effect_id)).toContain(effectId);
  });

  // -----------------------------------------------------------------------
  // Rest of the day, and a Round replay of a later round.
  // -----------------------------------------------------------------------

  it("lasts the rest of the day and survives a Round replay of a later round", async () => {
    const [holder, other] = await players("day-a", "day-b");

    // Round 1: cast.
    const r1 = await openRound(holder, [other]);
    await castLastCuppa(holder, r1);
    await close(holder, r1);
    await seedRoll(r1, holder.googleSub, 5);
    await seedRoll(r1, other.googleSub, 12);
    expect((await resolve(holder.client, r1)).brewer_id).toBe(other.googleSub);
    await markResolved(r1);

    // Rounds 2 and 3: no cast; the holder rolls lowest and still never brews.
    for (let i = 0; i < 2; i++) {
      const r = await openAndCloseRound(holder, [other]);
      await seedRoll(r, holder.googleSub, 1);
      await seedRoll(r, other.googleSub, 19);
      expect((await resolve(holder.client, r)).brewer_id).toBe(other.googleSub);
      await markResolved(r);
    }

    // Round 4 is replayed by Time for Brew; the replayed generation still
    // honours the immunity promoted in round 1.
    const r4 = await openAndCloseRound(holder, [other]);
    await seedRoll(r4, holder.googleSub, 3);
    await seedRoll(r4, other.googleSub, 14);
    await seedCast(r4, other, "Time for Brew", { effectKind: "round_replay" });
    const gen0 = await resolve(holder.client, r4);
    expect(gen0.brewer_id).toBe(other.googleSub);
    const { error: resErr } = await holder.client.rpc("resolve_round", {
      p_round_id: r4,
      p_brewer_id: other.googleSub,
      p_cups_made: 2,
    });
    expect(resErr).toBeNull();
    const { error: recErr } = await other.client.rpc("record_pending_round_replay", { p_round_id: r4 });
    expect(recErr).toBeNull();
    const { error: confErr } = await other.client.rpc("confirm_round_replay", { p_round_id: r4 });
    expect(confErr).toBeNull();

    const { data: replayed } = await admin
      .from("rounds")
      .select("status, replay_generation")
      .eq("id", r4)
      .single();
    expect(replayed).toMatchObject({ status: "closed", replay_generation: 1 });

    await seedRoll(r4, holder.googleSub, 2);
    await seedRoll(r4, other.googleSub, 13);
    const gen1 = await resolve(holder.client, r4);
    expect(gen1.brewer_id).toBe(other.googleSub);
    expect(immunitySteps(gen1).map((s) => s.immunity_tier)).toEqual(["lowest_roller"]);
  });

  it("a Last Cuppa countered in the layer-0 Reaction Window grants no immunity", async () => {
    const [holder, other] = await players("neg-a", "neg-b");
    const roundId = await openRound(holder, [other]);
    const castId = await castLastCuppa(holder, roundId);
    await close(holder, roundId);
    // The counter's effect: the whole cast is negated.
    await admin.from("spell_casts").update({ negated: true }).eq("id", castId);
    await seedRoll(roundId, holder.googleSub, 2);
    await seedRoll(roundId, other.googleSub, 17);

    const out = await resolve(holder.client, roundId);
    expect(out.brewer_id).toBe(holder.googleSub);
    expect(immunitySteps(out)).toHaveLength(0);
  });
});
