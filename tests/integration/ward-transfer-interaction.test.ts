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

// Runs against a real Supabase stack. Covers issue #344 — ward interaction
// for the modifier-transfer / round-scoped snapshot cards (migration 0089,
// on top of #342 / #343). A transfer or steal is atomic: when the side that
// LOSES modifier holds a matching active ward the whole effect no-ops that
// resolve (both sides), outcome `blocked`, and the casting card is still
// spent. Detection is at cast time for the four Action cards (Chai-nge of
// Heart / Tea Leaf / Spillage / Bes-Tea) and per tick, inside resolve_round,
// for Bitter Leech. Assertions are on externally observable outcomes only.

type TraceStep = {
  index: number;
  display_kind: string;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
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
  brewer_id: string | null;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("ward × modifier-transfer interaction (issue #344)", () => {
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

  async function setBaseModifier(actor: Player, target: Player, delta: number) {
    if (delta === 0) return;
    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: delta,
      p_reason: "issue #344 test baseline",
    });
    expect(error).toBeNull();
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

  async function startRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function closeRound(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  async function markResolved(roundId: string) {
    const { error } = await admin
      .from("rounds")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", roundId);
    expect(error).toBeNull();
  }

  async function roomModifier(roomId: string, playerId: string) {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", roomId)
      .eq("player_id", playerId)
      .single();
    expect(error).toBeNull();
    return data!.modifier as number;
  }

  async function breakdown(client: SupabaseClient, player: Player) {
    const { data, error } = await client
      .rpc("get_modifier_breakdown", { p_player_id: player.googleSub, p_room_id: player.roomId })
      .single();
    expect(error).toBeNull();
    return data as { cups_made: number; adjustments: number; spell_effects: number };
  }

  /** cups + adjustments + spell_effects must equal the room_players cache. */
  async function expectReconciled(client: SupabaseClient, player: Player) {
    const b = await breakdown(client, player);
    expect(b.cups_made + b.adjustments + b.spell_effects).toBe(
      await roomModifier(player.roomId, player.googleSub),
    );
    return b;
  }

  /** A ward "carried in from an earlier round" — an unbounded spell_active_effects row. */
  async function seedWard(
    roomId: string,
    casterId: string,
    targetPlayerId: string,
    effectParams: Record<string, unknown>,
    cardName: string,
  ) {
    const { castId } = await seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId,
      casterId,
      cardName,
      effectKind: "ward",
      effectParams,
      roundsRemaining: null,
    });
    return castId;
  }

  async function instanceState(cardName: string) {
    const { data: card } = await admin.from("spell_cards").select("id").eq("name", cardName).single();
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("card_id", card!.id)
      .single();
    expect(error).toBeNull();
    return data as { location: string; held_by_player: string | null };
  }

  // ==========================================================================
  // Chai-nge of Heart
  // ==========================================================================

  it("a ward on the losing side blocks both sides of a Chai-nge swap; the card is still spent", async () => {
    const caster = await signUp("w344-chainge-caster");
    const target = await signUp("w344-chainge-target");
    // caster +8, target +2 → the swap would drop the caster by 6 (the loss).
    await setBaseModifier(target, caster, 8);
    await setBaseModifier(caster, target, 2);
    // Cast-Iron Kettle is the caster's own negative-modifier ward.
    const wardCastId = await seedWard(
      caster.roomId,
      caster.googleSub,
      caster.googleSub,
      { polarity: ["negative"], domain: ["modifier", "roll"] },
      "Cast-Iron Kettle",
    );

    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Chai-nge of Heart");
    const { data: castId, error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castErr).toBeNull();
    expect(castId).toBeTruthy();

    await closeRound(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 10, 8);
    await seedRoll(roundId, target.googleSub, 11, 2);
    const out = await resolve(caster.client, roundId);

    // Neither cache moved — the swap no-opped.
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(8);
    expect(await roomModifier(target.roomId, target.googleSub)).toBe(2);
    expect((await expectReconciled(caster.client, caster)).spell_effects).toBe(0);
    expect((await expectReconciled(target.client, target)).spell_effects).toBe(0);

    // Both transfer rows are negated.
    const { data: rows } = await admin
      .from("spell_casts")
      .select("negated")
      .eq("round_id", roundId)
      .eq("effect_kind", "persistent_modifier_transfer");
    expect(rows).toHaveLength(2);
    expect(rows!.every((r) => r.negated === true)).toBe(true);

    // The card is spent — the instance is not back in the caster's hand.
    const inst = await instanceState("Chai-nge of Heart");
    expect(inst.held_by_player).toBeNull();
    expect(inst.location).not.toBe("held");

    // One warded/blocked step, naming the blocking ward.
    const warded = out.trace.filter((s) => s.display_kind === "warded");
    expect(warded).toHaveLength(1);
    expect(warded[0]).toMatchObject({
      target_player: caster.googleSub,
      outcome: "blocked",
      ward_cast_id: wardCastId,
      ward_card_name: "Cast-Iron Kettle",
    });
  });

  it("an unwarded Chai-nge swap still applies (control)", async () => {
    const caster = await signUp("w344-chainge-ok-caster");
    const target = await signUp("w344-chainge-ok-target");
    await setBaseModifier(target, caster, 8);
    await setBaseModifier(caster, target, 2);
    // Ward is on the GAINING side (target gains 6), so it does not gate.
    await seedWard(
      target.roomId,
      target.googleSub,
      target.googleSub,
      { polarity: ["negative"], domain: ["modifier"] },
      "Cast-Iron Kettle",
    );

    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Chai-nge of Heart");
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: target.googleSub });
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 10, 8);
    await seedRoll(roundId, target.googleSub, 11, 2);
    const out = await resolve(caster.client, roundId);

    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(2);
    expect(await roomModifier(target.roomId, target.googleSub)).toBe(8);
    expect(out.trace.some((s) => s.display_kind === "warded")).toBe(false);
  });

  it("the block is idempotent — a second resolve reproduces the caches and the Trace", async () => {
    const caster = await signUp("w344-chainge-idem-caster");
    const target = await signUp("w344-chainge-idem-target");
    await setBaseModifier(target, caster, 9);
    await setBaseModifier(caster, target, 1);
    await seedWard(
      caster.roomId,
      caster.googleSub,
      caster.googleSub,
      { polarity: ["negative"], domain: ["modifier"] },
      "Cast-Iron Kettle",
    );

    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Chai-nge of Heart");
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: target.googleSub });
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 10, 9);
    await seedRoll(roundId, target.googleSub, 11, 1);

    const first = await resolve(caster.client, roundId);
    const second = await resolve(caster.client, roundId);
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(9);
    expect(await roomModifier(target.roomId, target.googleSub)).toBe(1);
    const warded = (o: ResolveOutcome) => o.trace.filter((s) => s.display_kind === "warded");
    expect(warded(second)).toEqual(warded(first));
  });

  // ==========================================================================
  // Tea Leaf / Spillage
  // ==========================================================================

  it("a warded Tea Leaf target keeps their modifier and the caster gets no roll bonus", async () => {
    const caster = await signUp("w344-tealeaf-caster");
    const target = await signUp("w344-tealeaf-target");
    await setBaseModifier(target, target, 6); // target base +6
    await seedWard(
      caster.roomId,
      target.googleSub,
      target.googleSub,
      { polarity: ["positive", "negative"], domain: ["modifier"] },
      "Eternal Steep",
    );

    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Tea Leaf");
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: target.googleSub });
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 10, 0);
    await seedRoll(roundId, target.googleSub, 2, 6);
    const out = await resolve(caster.client, roundId);

    // Target keeps 2 + 6 = 8; caster keeps 10 + 0 (no stolen bonus) → target brews.
    expect(out.brewer_id).toBe(target.googleSub);
    // Neither the set_modifier (target) nor the flat_modifier (caster) applied.
    expect(out.trace.some((s) => ["set_modifier", "flat_modifier"].includes(s.display_kind))).toBe(false);
    const warded = out.trace.filter((s) => s.display_kind === "warded");
    expect(warded).toHaveLength(1);
    expect(warded[0]).toMatchObject({
      target_player: target.googleSub,
      outcome: "blocked",
      ward_card_name: "Eternal Steep",
      would_be_before: 6,
      would_be_after: 0,
    });

    // Both emitted rows negated; card spent.
    const { data: rows } = await admin
      .from("spell_casts")
      .select("negated")
      .eq("round_id", roundId)
      .in("effect_kind", ["set_modifier", "flat_modifier"]);
    expect(rows!.length).toBe(2);
    expect(rows!.every((r) => r.negated === true)).toBe(true);
    expect((await instanceState("Tea Leaf")).held_by_player).toBeNull();
  });

  it("a warded Spillage target keeps their modifier; an unwarded Spillage still moves floor(m/2)", async () => {
    // Warded
    const c1 = await signUp("w344-spill-c1");
    const t1 = await signUp("w344-spill-t1");
    await setBaseModifier(t1, t1, 8);
    await seedWard(
      c1.roomId,
      t1.googleSub,
      t1.googleSub,
      { polarity: ["negative"], domain: ["modifier"] },
      "Jinxed Biscuit",
    );
    const r1 = await startRound(c1, [t1]);
    await forceHold(admin, c1.googleSub, "Spillage");
    await c1.client.rpc("cast_spell_card", { p_round_id: r1, p_target_player_id: t1.googleSub });
    await closeRound(c1, r1);
    await seedRoll(r1, c1.googleSub, 12, 0);
    await seedRoll(r1, t1.googleSub, 3, 8);
    const out1 = await resolve(c1.client, r1);
    expect(out1.brewer_id).toBe(t1.googleSub); // kept: 3+8=11 < 12+0
    expect(out1.trace.filter((s) => s.display_kind === "warded")).toHaveLength(1);
    expect(out1.trace.some((s) => s.display_kind === "flat_modifier")).toBe(false);
    await markResolved(r1);

    // Unwarded control — reuse the same room (its round is now resolved).
    const c2 = c1;
    const t2 = t1;
    await admin.from("spell_active_effects").delete().eq("target_player_id", t1.googleSub);
    const r2 = await startRound(c2, [t2]);
    await forceHold(admin, c2.googleSub, "Spillage");
    await c2.client.rpc("cast_spell_card", { p_round_id: r2, p_target_player_id: t2.googleSub });
    await closeRound(c2, r2);
    await seedRoll(r2, c2.googleSub, 10, 0);
    await seedRoll(r2, t2.googleSub, 3, 8);
    const out2 = await resolve(c2.client, r2);
    // floor(8/2)=4 moves: target 3+4=7, caster 10+4=14 → caster brews... lowest brews: target 7 < caster 14.
    expect(out2.brewer_id).toBe(t2.googleSub);
    expect(out2.trace.some((s) => s.display_kind === "warded")).toBe(false);
    expect(out2.trace.some((s) => s.display_kind === "flat_modifier")).toBe(true);
  });

  // ==========================================================================
  // Bes-Tea
  // ==========================================================================

  it("Bes-Tea against a block_copy holder resolves blocked — the caster's round modifier is unchanged", async () => {
    const caster = await signUp("w344-bestea-caster");
    const target = await signUp("w344-bestea-target");
    await setBaseModifier(target, target, 9); // the value Bes-Tea would copy
    await seedWard(
      caster.roomId,
      target.googleSub,
      target.googleSub,
      { polarity: ["positive", "negative"], domain: ["modifier"], block_copy: true },
      "Bag for Life",
    );

    const roundId = await startRound(caster, [target]);
    await forceHold(admin, caster.googleSub, "Bes-Tea");
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: target.googleSub });
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster.googleSub, 8, 0);
    await seedRoll(roundId, target.googleSub, 8, 9);
    const out = await resolve(caster.client, roundId);

    // The copy did not happen: caster's round total stays 8 + 0, target 8 + 9 → target brews... lowest: caster 8 < target 17.
    expect(out.brewer_id).toBe(caster.googleSub);
    expect(out.trace.some((s) => s.display_kind === "set_modifier")).toBe(false);
    const warded = out.trace.filter((s) => s.display_kind === "warded");
    expect(warded).toHaveLength(1);
    // The step names the ward holder (the copied player), not the caster.
    expect(warded[0]).toMatchObject({
      target_player: target.googleSub,
      outcome: "blocked",
      ward_card_name: "Bag for Life",
    });
    expect((warded[0] as unknown as { target: string }).target).toBe(target.googleSub);

    const { data: rows } = await admin
      .from("spell_casts")
      .select("negated")
      .eq("round_id", roundId)
      .eq("effect_kind", "set_modifier");
    expect(rows!.every((r) => r.negated === true)).toBe(true);
    expect((await instanceState("Bes-Tea")).held_by_player).toBeNull();
  });

  // ==========================================================================
  // Bitter Leech — per-tick
  // ==========================================================================

  it("a Bitter Leech tick landing on a warded victim is skipped; a later tick after the ward expires still applies", async () => {
    const caster = await signUp("w344-leech-caster");
    const victim = await signUp("w344-leech-victim");

    // A bounded ward: seedActiveEffect stands it up in its own prior resolved
    // round, so rounds_remaining 2 leaves it live through round 1 (the seed
    // round counts as one elapsed) and expired by round 2.
    const { castId: wardCast } = await seedActiveEffect(admin, cleanup, {
      roomId: caster.roomId,
      targetPlayerId: victim.googleSub,
      casterId: victim.googleSub,
      cardName: "Jinxed Biscuit",
      effectKind: "ward",
      effectParams: { polarity: ["negative"], domain: ["modifier"] },
      roundsRemaining: 2,
    });
    expect(wardCast).toBeTruthy();

    // Round 1 — cast Bitter Leech; the tick is warded off.
    const r1 = await startRound(caster, [victim]);
    await forceHold(admin, caster.googleSub, "Bitter Leech");
    const { error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_target_player_id: victim.googleSub,
    });
    expect(castErr).toBeNull();
    await closeRound(caster, r1);
    await seedRoll(r1, caster.googleSub, 10, 0);
    await seedRoll(r1, victim.googleSub, 11, 0);
    const out1 = await resolve(caster.client, r1);

    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(0);
    expect(await roomModifier(victim.roomId, victim.googleSub)).toBe(0);
    expect(out1.trace.filter((s) => s.display_kind === "warded")).toHaveLength(1);
    // Both synthesised tick rows negated.
    const { data: t1 } = await admin
      .from("spell_casts")
      .select("negated")
      .eq("round_id", r1)
      .contains("cast_inputs", { bitter_leech_tick: true });
    expect(t1!.length).toBe(2);
    expect(t1!.every((r) => r.negated === true)).toBe(true);
    await markResolved(r1);

    // Round 2 — the ward's duration is spent, so the drain now bites.
    const r2 = await startRound(caster, [victim]);
    await closeRound(caster, r2);
    await seedRoll(r2, caster.googleSub, 10, 0);
    await seedRoll(r2, victim.googleSub, 11, 0);
    const out2 = await resolve(caster.client, r2);
    expect(out2.trace.some((s) => s.display_kind === "warded")).toBe(false);
    expect(await roomModifier(caster.roomId, caster.googleSub)).toBe(1);
    expect(await roomModifier(victim.roomId, victim.googleSub)).toBe(-1);
    await expectReconciled(caster.client, caster);
    await expectReconciled(victim.client, victim);
  });
});
