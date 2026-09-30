import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  seedDedicatedRoom,
  seedPastRound,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #426 (spec #401, design #380):
// Last Drip -- "Force the winner of the previous round to make tea instead.
// They gain no modifier from this tea-making." A tea_maker_override with mode
// `prev_round_highest` and modifier_gain 0 at tier 2 of the ladder: the
// previous resolved round's highest layer-0 roller in the room brews (ties:
// lowest modifier_snapshot, then lowest player id). Inert, with a no-op Trace
// step and a reason, when there's no previous resolved round or that player
// isn't a Participant this round.
describe.skipIf(!hasAnonTestEnv)("Last Drip: previous round's highest roller brews (#426)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  type Player = Awaited<ReturnType<typeof signUpSignInAndEnterRoom>>;

  type TraceStep = {
    display_kind: string;
    target_player: string | null;
    outcome: string;
    after: { type: string; value: string | number | null };
    override_reason?: string;
    source_cast: { card_name: string | null };
  };

  type ResolveOut = {
    outcome: string;
    brewer_id: string | null;
    brewer_source: string | null;
    modifier_gain: number | null;
    trace: TraceStep[];
  };

  /** Signs up the players into their own room, so no other test's rounds count as "previous". */
  async function players<const L extends readonly string[]>(...labels: L): Promise<{ [K in keyof L]: Player }> {
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `ld-${l}`)));
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

  async function closeRound(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function castLastDrip(caster: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, "Last Drip");
    const { error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  /** A competing tea_maker_override recorded straight into the Cast Log. */
  async function seedOverride(roundId: string, caster: Player, donorCard: string, mode: string) {
    const instanceId = await forceHold(admin, caster.googleSub, donorCard);
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    const { error } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: caster.googleSub,
      card_instance_id: instanceId,
      target_player_id: null,
      target_pending: false,
      effect_kind: "tea_maker_override",
      effect_params: { mode },
    });
    expect(error).toBeNull();
  }

  async function seedRoll(roundId: string, p: Player, value: number, modifierSnapshot = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: p.googleSub,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: modifierSnapshot,
    });
    expect(error).toBeNull();
  }

  async function resolve(p: Player, roundId: string) {
    const { data, error } = await p.client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOut;
  }

  async function finalize(p: Player, roundId: string) {
    const { error: wErr } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" });
    expect(wErr).toBeNull();
    const { error } = await p.client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function roundRow(roundId: string) {
    const { data, error } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made, brewer_modifier_gain")
      .eq("id", roundId)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function liveModifier(p: Player) {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", p.roomId)
      .eq("player_id", p.googleSub)
      .single();
    expect(error).toBeNull();
    return data!.modifier as number;
  }

  function overrideSteps(out: ResolveOut) {
    return out.trace.filter((s) => s.display_kind === "tea_maker_override");
  }

  it("is un-benched: the card is in the deck and carries a prev_round_highest override with no gain", async () => {
    const { data: card, error } = await admin
      .from("spell_cards")
      .select("id, spell_deck_instances(location), spell_card_effects(target_role, effect_kind, effect_params)")
      .eq("name", "Last Drip")
      .single();
    expect(error).toBeNull();
    const c = card as unknown as {
      spell_deck_instances: { location: string }[];
      spell_card_effects: { target_role: string; effect_kind: string; effect_params: Record<string, unknown> }[];
    };
    expect(c.spell_deck_instances.map((i) => i.location)).not.toContain("benched");
    expect(c.spell_card_effects).toEqual([
      {
        target_role: "TABLE",
        effect_kind: "tea_maker_override",
        effect_params: { mode: "prev_round_highest", modifier_gain: 0 },
      },
    ]);
  });

  it("the previous round's highest roller brews and gains no modifier", async () => {
    const [caster, winner, low] = await players("hp-caster", "hp-winner", "hp-low");
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 9 },
      { playerId: winner.googleSub, value: 18 },
      { playerId: low.googleSub, value: 2 },
    ]);

    const roundId = await openRound(caster, [winner, low]);
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster, 10);
    await seedRoll(roundId, winner, 15);
    await seedRoll(roundId, low, 3);

    const out = await resolve(caster, roundId);
    expect(out).toMatchObject({
      outcome: "brewer",
      brewer_id: winner.googleSub,
      brewer_source: "tea_maker_override:prev_round_highest",
      modifier_gain: 0,
    });
    expect(overrideSteps(out)).toEqual([
      expect.objectContaining({
        target_player: winner.googleSub,
        outcome: "applied",
        after: { type: "status", value: "brewer (no modifier gain)" },
        source_cast: expect.objectContaining({ card_name: "Last Drip" }),
      }),
    ]);

    await finalize(caster, roundId);
    expect(await roundRow(roundId)).toMatchObject({
      status: "resolved",
      brewer_id: winner.googleSub,
      cups_made: 3,
      brewer_modifier_gain: 0,
    });
    expect(await liveModifier(winner)).toBe(0);
  });

  it("reads the most recent resolved round, ignoring older and cancelled ones", async () => {
    const [caster, a, b] = await players("mr-caster", "mr-a", "mr-b");
    // oldest resolved: a won
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 5 },
      { playerId: a.googleSub, value: 19 },
      { playerId: b.googleSub, value: 4 },
    ], { minutesAgo: 90 });
    // most recent resolved: b won
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 5 },
      { playerId: a.googleSub, value: 6 },
      { playerId: b.googleSub, value: 17 },
    ], { minutesAgo: 60 });
    // a later cancelled round doesn't count: a "won" it
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 5 },
      { playerId: a.googleSub, value: 20 },
    ], { minutesAgo: 30, status: "cancelled" });

    const roundId = await openRound(caster, [a, b]);
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster, 2);
    await seedRoll(roundId, a, 11);
    await seedRoll(roundId, b, 12);

    const out = await resolve(caster, roundId);
    expect(out.brewer_id).toBe(b.googleSub);
  });

  it("breaks a tie for highest on the lowest modifier snapshot", async () => {
    const [caster, hiMod, loMod] = await players("tm-caster", "tm-himod", "tm-lomod");
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 3 },
      { playerId: hiMod.googleSub, value: 16, modifierSnapshot: 4 },
      { playerId: loMod.googleSub, value: 16, modifierSnapshot: 1 },
    ]);

    const roundId = await openRound(caster, [hiMod, loMod]);
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster, 2);
    await seedRoll(roundId, hiMod, 11);
    await seedRoll(roundId, loMod, 12);

    expect((await resolve(caster, roundId)).brewer_id).toBe(loMod.googleSub);
  });

  it("breaks a full tie (roll and snapshot) on the lowest player id", async () => {
    const [caster, x, y] = await players("tp-caster", "tp-x", "tp-y");
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 3 },
      { playerId: x.googleSub, value: 14, modifierSnapshot: 2 },
      { playerId: y.googleSub, value: 14, modifierSnapshot: 2 },
    ]);
    const expected = [x.googleSub, y.googleSub].sort()[0];

    const roundId = await openRound(caster, [x, y]);
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster, 2);
    await seedRoll(roundId, x, 11);
    await seedRoll(roundId, y, 12);

    expect((await resolve(caster, roundId)).brewer_id).toBe(expected);
  });

  it("does nothing when there's no previous resolved round: a no-op step, and the default pick stands", async () => {
    const [caster, other] = await players("np-caster", "np-other");
    // an earlier cancelled round is not a resolved one
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: other.googleSub, value: 20 },
    ], { status: "cancelled" });

    const roundId = await openRound(caster, [other]);
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster, 15);
    await seedRoll(roundId, other, 4);

    const out = await resolve(caster, roundId);
    expect(out).toMatchObject({ brewer_id: other.googleSub, brewer_source: "default", modifier_gain: null });
    expect(overrideSteps(out)).toEqual([
      expect.objectContaining({
        target_player: null,
        outcome: "no-op",
        after: { type: "status", value: "no effect" },
        override_reason: "no_previous_round",
      }),
    ]);

    await finalize(caster, roundId);
    expect(await roundRow(roundId)).toMatchObject({ brewer_id: other.googleSub, brewer_modifier_gain: 2 });
  });

  it("does nothing when the previous winner isn't taking part this round", async () => {
    const [caster, absent, other] = await players("ab-caster", "ab-absent", "ab-other");
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 5 },
      { playerId: absent.googleSub, value: 19 },
      { playerId: other.googleSub, value: 6 },
    ]);

    const roundId = await openRound(caster, [other]);
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster, 15);
    await seedRoll(roundId, other, 4);

    const out = await resolve(caster, roundId);
    expect(out).toMatchObject({ brewer_id: other.googleSub, brewer_source: "default", modifier_gain: null });
    expect(overrideSteps(out)).toEqual([
      expect.objectContaining({
        target_player: absent.googleSub,
        outcome: "no-op",
        after: { type: "status", value: "no effect" },
        override_reason: "target_absent",
      }),
    ]);
  });

  it("a later override beats it (last cast wins)", async () => {
    const [caster, winner, top] = await players("lw-caster", "lw-winner", "lw-top");
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 5 },
      { playerId: winner.googleSub, value: 19 },
      { playerId: top.googleSub, value: 6 },
    ]);

    const roundId = await openRound(caster, [winner, top]);
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedOverride(roundId, top, "Topsy-Tea", "highest_roll");
    await seedRoll(roundId, caster, 3);
    await seedRoll(roundId, winner, 10);
    await seedRoll(roundId, top, 18);

    const out = await resolve(caster, roundId);
    expect(out).toMatchObject({ brewer_id: top.googleSub, brewer_source: "tea_maker_override:highest_roll" });
  });

  it("beats an earlier override when it's cast last", async () => {
    const [caster, winner, top] = await players("le-caster", "le-winner", "le-top");
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 5 },
      { playerId: winner.googleSub, value: 19 },
      { playerId: top.googleSub, value: 6 },
    ]);

    const roundId = await openRound(caster, [winner, top]);
    await seedOverride(roundId, top, "Topsy-Tea", "highest_roll");
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster, 3);
    await seedRoll(roundId, winner, 10);
    await seedRoll(roundId, top, 18);

    const out = await resolve(caster, roundId);
    expect(out).toMatchObject({
      brewer_id: winner.googleSub,
      brewer_source: "tea_maker_override:prev_round_highest",
      modifier_gain: 0,
    });
  });

  it("an inert Last Drip cast last lets the earlier override stand", async () => {
    const [caster, top] = await players("fi-caster", "fi-top");

    const roundId = await openRound(caster, [top]);
    await seedOverride(roundId, top, "Topsy-Tea", "highest_roll");
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedRoll(roundId, caster, 3);
    await seedRoll(roundId, top, 18);

    const out = await resolve(caster, roundId);
    expect(out).toMatchObject({ brewer_id: top.googleSub, brewer_source: "tea_maker_override:highest_roll" });
    expect(overrideSteps(out).map((s) => [s.source_cast.card_name, s.outcome, s.override_reason ?? null])).toEqual([
      ["Last Drip", "no-op", "no_previous_round"],
      ["Topsy-Tea", "applied", null],
    ]);
  });

  it("a declared number outranks it", async () => {
    const [caster, winner, match] = await players("dn-caster", "dn-winner", "dn-match");
    await seedPastRound(admin, cleanup, caster.roomId, [
      { playerId: caster.googleSub, value: 5 },
      { playerId: winner.googleSub, value: 19 },
      { playerId: match.googleSub, value: 6 },
    ]);

    const roundId = await openRound(caster, [winner, match]);
    await castLastDrip(caster, roundId);
    await closeRound(caster, roundId);
    await seedActiveEffect(admin, cleanup, {
      roomId: caster.roomId,
      targetPlayerId: match.googleSub,
      casterId: match.googleSub,
      cardName: "Inscribed Saucer",
      effectKind: "declared_number_tea_maker",
      effectParams: { number: 13 },
      roundsRemaining: 1,
    });
    await seedRoll(roundId, caster, 3);
    await seedRoll(roundId, winner, 10);
    await seedRoll(roundId, match, 13);

    const out = await resolve(caster, roundId);
    expect(out).toMatchObject({ brewer_id: match.googleSub, brewer_source: "declared_number" });
  });
});
