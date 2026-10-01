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

// Runs against a real Supabase stack. Issue #432 (spec #401, design #382):
// Brew IOU -- "Choose a target to make tea this round; you make it next
// round, no roll required."
//
//   * This round: a plain `chosen` tea_maker_override. When it actually names
//     the Tea Maker, the round records ('brew_iou', cast) in
//     rounds.brewer_source / brewer_source_cast_id -- a Brew Debt.
//   * A debt is live while no round has recorded ('brew_debt', cast). The
//     Debtor's next round as a Participant -- any room, any day -- is a debt
//     round: nobody rolls, no Reaction Window, it resolves at close with the
//     Debtor as Tea Maker. An immune Debtor plays normally and still owes.
// Assertions are on observable outcomes: the brewer, rounds.brewer_source,
// modifiers, who is expected to roll, and the Resolution Trace.

type TraceStep = {
  display_kind: string;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  brew_debt?: string;
};

type RoundRow = {
  status: string;
  brewer_id: string | null;
  brewer_source: string | null;
  brewer_source_cast_id: string | null;
  brewer_modifier_gain: number | null;
  cups_made: number | null;
  resolution_trace: TraceStep[] | null;
};

const BREW_IOU = "Brew IOU";

describe.skipIf(!hasAnonTestEnv)("Brew IOU (#432)", () => {
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
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `iou-${l}`)));
    const roomId = await seedDedicatedRoom(
      admin,
      cleanup,
      ps.map((p) => p.googleSub),
    );
    return ps.map((p) => ({ ...p, roomId })) as { [K in keyof L]: Player };
  }

  /** Another room (another day) with these players. */
  function anotherRoom(ps: Player[]) {
    return seedDedicatedRoom(
      admin,
      cleanup,
      ps.map((p) => p.googleSub),
    );
  }

  async function openRound(starter: Player, others: Player[], roomId = starter.roomId): Promise<string> {
    const { data: roundId, error } = await starter.client.rpc("start_round", { p_room_id: roomId });
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

  async function seedRoll(roundId: string, playerId: string, value: number) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: 0,
    });
    expect(error).toBeNull();
  }

  /** What advanceRound does for any event but reactionWindowChanged. */
  async function advance(client: SupabaseClient, roundId: string) {
    const { data, error } = await client.rpc("advance_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as {
      outcome: string;
      reason?: string;
      brewer_id?: string;
      window_closed?: boolean;
      finalization?: { outcome: string; brewer_id?: string } | null;
    };
  }

  /** Rolls everyone in, then advances: nobody holds a Reaction card, so the window closes on the spot. */
  async function rollAndResolve(starter: Player, roundId: string, rolls: [Player, number][]) {
    for (const [p, v] of rolls) await seedRoll(roundId, p.googleSub, v);
    const out = await advance(starter.client, roundId);
    expect(out.outcome).toBe("windowOpened");
    expect(out.window_closed).toBe(true);
    return out.finalization!;
  }

  /** Brew IOU, cast for real through cast_spell_card while `roundId` is open. */
  async function castBrewIou(caster: Player, roundId: string, target: Player) {
    await forceHold(admin, caster.googleSub, BREW_IOU);
    const { data, error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(error).toBeNull();
    return data as string;
  }

  /** A full Brew IOU round: `caster` names `target`, who rolls highest; returns the round and cast. */
  async function brewIouRound(caster: Player, target: Player, others: Player[], roomId = caster.roomId) {
    const roundId = await openRound(caster, [target, ...others], roomId);
    const castId = await castBrewIou(caster, roundId, target);
    await close(caster, roundId);
    const fin = await rollAndResolve(caster, roundId, [
      [caster, 2],
      [target, 19],
      ...others.map((o, i): [Player, number] => [o, 8 + i]),
    ]);
    expect(fin).toMatchObject({ outcome: "brewer", brewer_id: target.googleSub });
    return { roundId, castId };
  }

  async function round(roundId: string): Promise<RoundRow> {
    const { data, error } = await admin
      .from("rounds")
      .select("status, brewer_id, brewer_source, brewer_source_cast_id, brewer_modifier_gain, cups_made, resolution_trace")
      .eq("id", roundId)
      .single();
    expect(error).toBeNull();
    return data as RoundRow;
  }

  async function debtDue(roundId: string) {
    const { data, error } = await admin.rpc("_brew_debt_due", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { debtor_player_id: string; cast_id: string } | null;
  }

  async function expectedRollers(roundId: string, as: Player) {
    const { data, error } = await as.client.rpc("get_expected_layer_roller_ids", { p_round_id: roundId, p_layer: 0 });
    expect(error).toBeNull();
    return (data as { player_id: string }[]).map((r) => r.player_id).sort();
  }

  async function modifierOf(roomId: string, playerId: string) {
    const { data } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", roomId)
      .eq("player_id", playerId)
      .single();
    return data!.modifier as number;
  }

  /** A debt round: close it and expect it to resolve at close to `debtor`. */
  async function payDebt(starter: Player, roundId: string, debtor: Player) {
    await close(starter, roundId);
    expect(await expectedRollers(roundId, starter)).toEqual([]);
    const out = await advance(starter.client, roundId);
    expect(out).toMatchObject({ outcome: "brewer", brewer_id: debtor.googleSub });
    const { data: windows } = await admin.from("spell_reaction_windows").select("id").eq("round_id", roundId);
    expect(windows).toEqual([]);
    return round(roundId);
  }

  function lastCuppa(holder: Player, roomId = holder.roomId) {
    return seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId: holder.googleSub,
      casterId: holder.googleSub,
      cardName: "The Last Cuppa",
      effectKind: "brewer_immunity",
      effectParams: { mode: "last_cuppa", persist: true, override_proof: true },
      roundsRemaining: null,
    });
  }

  const steps = (r: RoundRow, kind: string) => (r.resolution_trace ?? []).filter((s) => s.display_kind === kind);

  // -----------------------------------------------------------------------
  // The card and the Brew IOU round.
  // -----------------------------------------------------------------------

  it("is un-benched, with a `chosen` override row flagged as creating a Brew Debt", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", BREW_IOU)
      .single();
    expect(inst!.location).not.toBe("benched");

    const { data: effects } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params, spell_cards!inner(name)")
      .eq("spell_cards.name", BREW_IOU);
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      target_role: "TARGET",
      effect_kind: "tea_maker_override",
      effect_params: { mode: "chosen", creates_brew_debt: true },
    });
  });

  it("the target brews this round with normal gain, and the caster owes a Brew Debt", async () => {
    const [caster, target, other] = await players("a-caster", "a-target", "a-other");
    const { roundId, castId } = await brewIouRound(caster, target, [other]);

    const r = await round(roundId);
    expect(r).toMatchObject({
      brewer_id: target.googleSub,
      brewer_source: "brew_iou",
      brewer_source_cast_id: castId,
      brewer_modifier_gain: 3,
    });
    expect(await modifierOf(caster.roomId, target.googleSub)).toBe(3);

    const [created] = steps(r, "brew_debt");
    expect(created).toMatchObject({
      target_player: caster.googleSub,
      source_cast: { cast_id: castId, card_name: BREW_IOU, caster_player_id: caster.googleSub },
      before: { value: "clear" },
      after: { value: "owes" },
      brew_debt: "created",
    });
  });

  // -----------------------------------------------------------------------
  // No debt unless Brew IOU actually picked the Tea Maker.
  // -----------------------------------------------------------------------

  describe("no debt when the override didn't pick the Tea Maker", () => {
    /** A Brew IOU Cast Log row seeded straight into the table. */
    async function seedBrewIou(roundId: string, caster: Player, target: Player, over: { negated?: boolean } = {}) {
      const instanceId = await forceHold(admin, caster.googleSub, BREW_IOU);
      await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", instanceId);
      const { data, error } = await admin
        .from("spell_casts")
        .insert({
          round_id: roundId,
          caster_id: caster.googleSub,
          card_instance_id: instanceId,
          target_player_id: target.googleSub,
          target_pending: false,
          effect_kind: "tea_maker_override",
          effect_params: { mode: "chosen", creates_brew_debt: true },
          negated: over.negated ?? false,
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      return data!.id as string;
    }

    async function setup() {
      const [caster, target, low] = await players("n-caster", "n-target", "n-low");
      const roundId = await openRound(caster, [target, low]);
      await close(caster, roundId);
      return { caster, target, low, roundId };
    }

    it("countered (negated): the default pick brews, no debt", async () => {
      const { caster, target, low, roundId } = await setup();
      await seedBrewIou(roundId, caster, target, { negated: true });
      const fin = await rollAndResolve(caster, roundId, [[caster, 10], [target, 18], [low, 3]]);
      expect(fin.brewer_id).toBe(low.googleSub);
      const r = await round(roundId);
      expect(r.brewer_source).toBeNull();
      expect(steps(r, "brew_debt")).toEqual([]);
    });

    it("out-ranked by a later override: no debt", async () => {
      const { caster, target, low, roundId } = await setup();
      await seedBrewIou(roundId, caster, target);
      // a later plain `chosen` override (Drip Tray donor) wins last-cast-wins
      const instanceId = await forceHold(admin, low.googleSub, "Drip Tray");
      await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", instanceId);
      const { error } = await admin.from("spell_casts").insert({
        round_id: roundId,
        caster_id: low.googleSub,
        card_instance_id: instanceId,
        target_player_id: caster.googleSub,
        target_pending: false,
        effect_kind: "tea_maker_override",
        effect_params: { mode: "chosen" },
        cast_at: new Date(Date.now() + 1000).toISOString(),
      });
      expect(error).toBeNull();

      const fin = await rollAndResolve(caster, roundId, [[caster, 10], [target, 18], [low, 3]]);
      expect(fin.brewer_id).toBe(caster.googleSub);
      expect((await round(roundId)).brewer_source).toBeNull();
    });

    it("an immune target: the override falls through to the default pick, no debt", async () => {
      const { caster, target, low, roundId } = await setup();
      await lastCuppa(target);
      await seedBrewIou(roundId, caster, target);
      const fin = await rollAndResolve(caster, roundId, [[caster, 10], [target, 18], [low, 3]]);
      expect(fin.brewer_id).toBe(low.googleSub);
      expect((await round(roundId)).brewer_source).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // The debt round.
  // -----------------------------------------------------------------------

  it("the Debtor's next round resolves at close to them: no rolls, no window, normal gain", async () => {
    const [caster, target, other] = await players("d-caster", "d-target", "d-other");
    const { castId } = await brewIouRound(caster, target, [other]);
    const before = await modifierOf(caster.roomId, caster.googleSub);

    const debtRound = await openRound(target, [caster, other]);
    expect(await debtDue(debtRound)).toMatchObject({ debtor_player_id: caster.googleSub, cast_id: castId });
    const r = await payDebt(target, debtRound, caster);

    expect(r).toMatchObject({
      status: "resolved",
      brewer_id: caster.googleSub,
      brewer_source: "brew_debt",
      brewer_source_cast_id: castId,
      brewer_modifier_gain: 3,
      cups_made: 3,
    });
    expect(await modifierOf(caster.roomId, caster.googleSub)).toBe(before + 3);
    const { data: rolls, error: rollsErr } = await admin.from("rolls").select("player_id").eq("round_id", debtRound);
    expect(rollsErr).toBeNull();
    expect(rolls).toEqual([]);

    const [paid] = steps(r, "brew_debt");
    expect(paid).toMatchObject({
      target_player: caster.googleSub,
      source_cast: { cast_id: castId, card_name: BREW_IOU },
      after: { value: "brewer" },
      brew_debt: "paid",
    });

    // Paid: the round after is a normal one.
    const next = await openRound(target, [caster, other]);
    await close(target, next);
    expect(await debtDue(next)).toBeNull();
    expect(await expectedRollers(next, caster)).toEqual([caster.googleSub, other.googleSub, target.googleSub].sort());
  });

  it("nobody can roll in a debt round", async () => {
    const [caster, target] = await players("r-caster", "r-target");
    await brewIouRound(caster, target, []);

    const debtRound = await openRound(target, [caster]);
    await close(target, debtRound);
    const { data: canRoll } = await target.client.rpc("is_expected_layer_roller", {
      p_round_id: debtRound,
      p_player_id: target.googleSub,
      p_layer: 0,
    });
    expect(canRoll).toBe(false);
    const { error } = await target.client.rpc("submit_roll", { p_round_id: debtRound });
    expect(error).not.toBeNull();
  });

  it("the debt survives into another room (another day), and is paid there", async () => {
    const [caster, target, other] = await players("x-caster", "x-target", "x-other");
    const { castId } = await brewIouRound(caster, target, [other]);

    const room2 = await anotherRoom([caster, other]);
    const debtRound = await openRound(other, [caster], room2);
    const r = await payDebt(other, debtRound, caster);
    expect(r).toMatchObject({ brewer_source: "brew_debt", brewer_source_cast_id: castId });
    expect(await modifierOf(room2, caster.googleSub)).toBe(2);
  });

  it("a debt from a real room is not paid in the Test Room", async () => {
    const [caster, target] = await players("t-caster", "t-target");
    await brewIouRound(caster, target, []);

    const testRoom = await seedDedicatedRoom(admin, cleanup, [caster.googleSub, target.googleSub], { isTest: true });
    const { data: roundId, error } = await caster.client.rpc("start_round", { p_room_id: testRoom });
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    expect(await debtDue(roundId as string)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Immunity, Earl, several Debtors, owing twice, Late Declare.
  // -----------------------------------------------------------------------

  it("an immune Debtor plays the round normally and still owes", async () => {
    const [caster, target, other] = await players("i-caster", "i-target", "i-other");
    const { castId } = await brewIouRound(caster, target, [other]);
    await lastCuppa(caster);

    const normal = await openRound(target, [caster, other]);
    await close(target, normal);
    expect(await debtDue(normal)).toBeNull();
    expect(await expectedRollers(normal, caster)).toHaveLength(3);
    const fin = await rollAndResolve(target, normal, [[caster, 1], [target, 10], [other, 12]]);
    // immune: the next-lowest brews
    expect(fin.brewer_id).toBe(target.googleSub);
    expect((await round(normal)).brewer_source).toBeNull();

    // Another day, no immunity: the debt is paid.
    const room2 = await anotherRoom([caster, other]);
    const later = await openRound(other, [caster], room2);
    expect(await debtDue(later)).toMatchObject({ cast_id: castId });
  });

  it("targeting the Earl: the title passes to the caster, the debt is created and waits", async () => {
    const [caster, earl, other] = await players("e-caster", "e-earl", "e-other");
    await seedActiveEffect(admin, cleanup, {
      roomId: earl.roomId,
      targetPlayerId: earl.googleSub,
      casterId: earl.googleSub,
      cardName: "Earl of Earl Grey",
      effectKind: "brewer_immunity",
      effectParams: { mode: "earl", persist: true },
      roundsRemaining: null,
    });
    const { roundId, castId } = await brewIouRound(caster, earl, [other]);

    const r = await round(roundId);
    expect(r).toMatchObject({ brewer_id: earl.googleSub, brewer_source: "brew_iou", brewer_source_cast_id: castId });
    expect(steps(r, "earl_transfer")).toHaveLength(1);

    // The caster is now Earl -- immune -- so the debt waits.
    const next = await openRound(earl, [caster, other]);
    await close(earl, next);
    expect(await debtDue(next)).toBeNull();
    expect(await expectedRollers(next, caster)).toHaveLength(3);
  });

  it("several Debtors: the oldest debt pays, the others stay owed; an immune Debtor is skipped", async () => {
    const [a, b, c] = await players("s-a", "s-b", "s-c");
    const first = await brewIouRound(a, b, [c]);
    const second = await brewIouRound(c, b, [a]);

    // Both declared in: a's older debt pays.
    const r1 = await openRound(b, [a, c]);
    expect(await debtDue(r1)).toMatchObject({ debtor_player_id: a.googleSub, cast_id: first.castId });
    await payDebt(b, r1, a);

    // Then c's.
    const r2 = await openRound(b, [a, c]);
    expect(await debtDue(r2)).toMatchObject({ debtor_player_id: c.googleSub, cast_id: second.castId });
    await payDebt(b, r2, c);

    // Nobody owes now.
    const r3 = await openRound(b, [a, c]);
    expect(await debtDue(r3)).toBeNull();
  });

  it("several Debtors with the oldest immune: the next debt pays instead", async () => {
    const [a, b, c] = await players("m-a", "m-b", "m-c");
    await brewIouRound(a, b, [c]);
    const second = await brewIouRound(c, b, [a]);
    await lastCuppa(a);

    const r1 = await openRound(b, [a, c]);
    expect(await debtDue(r1)).toMatchObject({ debtor_player_id: c.googleSub, cast_id: second.castId });
  });

  it("owing twice: one debt per round, oldest first", async () => {
    const [a, b, c] = await players("w-a", "w-b", "w-c");
    const first = await brewIouRound(a, b, [c]);
    const second = await brewIouRound(a, c, [b]);

    const r1 = await openRound(b, [a, c]);
    expect((await payDebt(b, r1, a)).brewer_source_cast_id).toBe(first.castId);
    const r2 = await openRound(b, [a, c]);
    expect((await payDebt(b, r2, a)).brewer_source_cast_id).toBe(second.castId);
    const r3 = await openRound(b, [a, c]);
    expect(await debtDue(r3)).toBeNull();
  });

  it("a Debtor's Late Declare turns the round into a debt round only while nobody has rolled", async () => {
    const [a, b, c] = await players("l-a", "l-b", "l-c");
    await brewIouRound(a, b, [c]);

    // Nobody has rolled: the late declare converts the round.
    const r1 = await openRound(b, [c]);
    await close(b, r1);
    expect(await debtDue(r1)).toBeNull();
    const { error: lateErr } = await a.client.rpc("declare_in_late", { p_round_id: r1 });
    expect(lateErr).toBeNull();
    expect(await expectedRollers(r1, b)).toEqual([]);
    expect(await advance(a.client, r1)).toMatchObject({ outcome: "brewer", brewer_id: a.googleSub });
    expect((await round(r1)).brewer_source).toBe("brew_debt");
  });

  it("once someone has rolled, a Debtor can't declare in late and the round stays normal", async () => {
    const [a, b, c] = await players("k-a", "k-b", "k-c");
    await brewIouRound(a, b, [c]);

    const r1 = await openRound(b, [c]);
    await close(b, r1);
    await seedRoll(r1, b.googleSub, 7);
    const { error: lateErr } = await a.client.rpc("declare_in_late", { p_round_id: r1 });
    expect(lateErr?.code).toBe("RFB31");
    expect(await expectedRollers(r1, b)).toEqual([b.googleSub, c.googleSub].sort());
  });

  // -----------------------------------------------------------------------
  // Replay and admin deletion.
  // -----------------------------------------------------------------------

  async function makeAdmin(playerId: string) {
    const { error } = await admin.from("players").update({ is_admin: true }).eq("id", playerId);
    expect(error).toBeNull();
  }

  it("admin-deleting the paying round makes the debt owed again", async () => {
    const [a, b] = await players("ad-a", "ad-b");
    const { castId } = await brewIouRound(a, b, []);
    const paying = await openRound(b, [a]);
    await payDebt(b, paying, a);

    await makeAdmin(b.googleSub);
    const { error } = await b.client.rpc("admin_delete_round", { p_round_id: paying, p_reason: "issue #432 test" });
    expect(error).toBeNull();

    const next = await openRound(b, [a]);
    expect(await debtDue(next)).toMatchObject({ cast_id: castId });
  });

  it("admin-deleting the Brew IOU round erases the debt", async () => {
    const [a, b] = await players("ai-a", "ai-b");
    const { roundId } = await brewIouRound(a, b, []);

    await makeAdmin(b.googleSub);
    const { error } = await b.client.rpc("admin_delete_round", { p_round_id: roundId, p_reason: "issue #432 test" });
    expect(error).toBeNull();

    const next = await openRound(b, [a]);
    expect(await debtDue(next)).toBeNull();
  });

  /** Seeds a surviving Time for Brew on `roundId`, records the pending replay and confirms it (the scrap). */
  async function replay(roundId: string, caster: Player) {
    const instanceId = await forceHold(admin, caster.googleSub, "Time for Brew");
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", instanceId);
    const { error: castErr } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: caster.googleSub,
      card_instance_id: instanceId,
      target_pending: false,
      effect_kind: "round_replay",
      effect_params: {},
    });
    expect(castErr).toBeNull();
    const { data: recorded } = await caster.client.rpc("record_pending_round_replay", { p_round_id: roundId });
    expect(recorded).toBe(true);
    const { error } = await caster.client.rpc("confirm_round_replay", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  it("scrapping the paying round (Round replay) makes the debt owed again", async () => {
    const [a, b] = await players("rp-a", "rp-b");
    const { castId } = await brewIouRound(a, b, []);
    const paying = await openRound(b, [a]);
    await payDebt(b, paying, a);

    await replay(paying, b);
    const r = await round(paying);
    expect(r).toMatchObject({ status: "closed", brewer_source: null, brewer_source_cast_id: null });
    // The replayed round is the debt round again.
    expect(await debtDue(paying)).toMatchObject({ cast_id: castId });
  });

  it("scrapping the Brew IOU round erases the debt", async () => {
    const [a, b, c] = await players("ri-a", "ri-b", "ri-c");
    const { roundId } = await brewIouRound(a, b, [c]);

    await replay(roundId, c);
    expect(await round(roundId)).toMatchObject({ brewer_source: null, brewer_source_cast_id: null });

    const room2 = await anotherRoom([a, c]);
    const next = await openRound(c, [a], room2);
    expect(await debtDue(next)).toBeNull();
  });
});
