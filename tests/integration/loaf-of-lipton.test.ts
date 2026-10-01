import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enforceStallTimeout } from "../../src/app/rounds/stallEnforcement";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #433 (spec #401 F5, design #393):
// Roll Exemption, with Loaf of Lipton as its first user -- "Skip your roll
// this round and make tea automatically. You gain double the usual modifier."
//
//   * The card's catalog row carries `exempt_from_rolling: true`. Its caster
//     has no layer-0 roll: get_expected_layer_roller_ids leaves them out, so
//     the roll gate, Layer completeness and stall all follow.
//   * Loaf itself is a `chosen` self-override whose gain is 2 * cups_made.
//   * Countered: once the layer-0 Reaction Window has CLOSED with the cast
//     negated, the caster is an expected roller again and rolls late.
//   * Every participant exempt: the round resolves at close.
//   * The exemption covers layer 0 only, and a replay's clean slate wipes it.
// Assertions are on observable outcomes: who is expected to roll, the
// brewer and gain, modifiers, and the Resolution Trace.

type TraceStep = {
  display_kind: string;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  rolloff_opponent_ids?: string[];
};

type RoundRow = {
  status: string;
  current_layer: number;
  brewer_id: string | null;
  brewer_modifier_gain: number | null;
  cups_made: number | null;
  resolution_trace: TraceStep[] | null;
};

const LOAF = "Loaf of Lipton";

describe.skipIf(!hasAnonTestEnv)("Roll Exemption + Loaf of Lipton (#433)", () => {
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
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `loaf-${l}`)));
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

  async function seedRoll(roundId: string, playerId: string, value: number, layer = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer,
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
      tied_player_ids?: string[];
      window_closed?: boolean;
      finalization?: { outcome: string; brewer_id?: string; tied_player_ids?: string[]; rolloff?: boolean } | null;
    };
  }

  async function finalize(client: SupabaseClient, roundId: string) {
    const { data, error } = await client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { outcome: string; reason?: string; brewer_id?: string };
  }

  /** Loaf of Lipton, cast for real through cast_spell_card while `roundId` is open. */
  async function castLoaf(caster: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, LOAF);
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  async function expectedRollers(roundId: string, as: Player, layer = 0) {
    const { data, error } = await as.client.rpc("get_expected_layer_roller_ids", { p_round_id: roundId, p_layer: layer });
    expect(error).toBeNull();
    return (data as { player_id: string }[]).map((r) => r.player_id).sort();
  }

  async function round(roundId: string): Promise<RoundRow> {
    const { data, error } = await admin
      .from("rounds")
      .select("status, current_layer, brewer_id, brewer_modifier_gain, cups_made, resolution_trace")
      .eq("id", roundId)
      .single();
    expect(error).toBeNull();
    return data as RoundRow;
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

  /** An open layer-0 Reaction Window, seeded directly (the regression-net seam). */
  async function openWindow(roundId: string) {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "open" })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function closeWindow(windowId: string, closedAt = new Date()) {
    const { error } = await admin
      .from("spell_reaction_windows")
      .update({ status: "closed", closed_at: closedAt.toISOString() })
      .eq("id", windowId);
    expect(error).toBeNull();
  }

  /** A successful counter (contested_negate, d20 20) on `parentCastId`, cast in `windowId`. */
  async function counter(roundId: string, caster: Player, parentCastId: string, windowId: string) {
    const instanceId = await forceHold(admin, caster.googleSub, "Tannin Tantrum");
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", instanceId);
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: caster.googleSub,
        card_instance_id: instanceId,
        target_player_id: null,
        target_pending: false,
        effect_kind: "contested_negate",
        effect_params: {},
        cast_inputs: { dc_d20: 20 },
        parent_cast_id: parentCastId,
        reaction_window_id: windowId,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  function lastCuppa(holder: Player) {
    return seedActiveEffect(admin, cleanup, {
      roomId: holder.roomId,
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
  // The card.
  // -----------------------------------------------------------------------

  it("is un-benched, with one `chosen` self-override row: double gain, exempt from rolling", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", LOAF)
      .single();
    expect(inst!.location).not.toBe("benched");

    const { data: effects } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params, spell_cards!inner(name)")
      .eq("spell_cards.name", LOAF);
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      target_role: "CASTER",
      effect_kind: "tea_maker_override",
      effect_params: { mode: "chosen", modifier_gain_multiplier: 2, exempt_from_rolling: true },
    });
  });

  // -----------------------------------------------------------------------
  // The exemption and the Loaf round.
  // -----------------------------------------------------------------------

  it("the caster has no layer-0 roll; the round completes without it; they brew with double gain", async () => {
    const [ada, ben, cat] = await players("skip-a", "skip-b", "skip-c");
    const roundId = await openRound(ada, [ben, cat]);
    const castId = await castLoaf(ada, roundId);
    await close(ada, roundId);

    expect(await expectedRollers(roundId, ada)).toEqual([ben.googleSub, cat.googleSub].sort());
    const { error: rollErr } = await ada.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr?.message).toMatch(/not expected to roll/);

    await seedRoll(roundId, ben.googleSub, 3);
    await seedRoll(roundId, cat.googleSub, 15);
    const out = await advance(ada.client, roundId);
    expect(out).toMatchObject({ outcome: "windowOpened", window_closed: true });
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: ada.googleSub });

    const r = await round(roundId);
    expect(r).toMatchObject({ status: "resolved", brewer_id: ada.googleSub, cups_made: 3, brewer_modifier_gain: 6 });
    expect(await modifierOf(ada.roomId, ada.googleSub)).toBe(6);
    // Resolving (which rewrites Cast Log flags) leaves the exemption standing.
    expect(await expectedRollers(roundId, ada)).toEqual([ben.googleSub, cat.googleSub].sort());

    const [skip] = steps(r, "roll_exemption");
    expect(steps(r, "roll_exemption")).toHaveLength(1);
    expect(skip).toMatchObject({
      source_cast: { cast_id: castId, card_name: LOAF, caster_player_id: ada.googleSub },
      target_player: ada.googleSub,
      before: { type: "status", value: "rolls" },
      after: { type: "status", value: "skipped" },
    });
    const [override] = steps(r, "tea_maker_override");
    expect(override).toMatchObject({ target_player: ada.googleSub, after: { value: "brewer" } });
  });

  it("a later override on someone else beats Loaf; the caster still skipped their roll", async () => {
    const [ada, ben, cat] = await players("later-a", "later-b", "later-c");
    const roundId = await openRound(ada, [ben, cat]);
    await castLoaf(ada, roundId);
    await forceHold(admin, ben.googleSub, "Brew IOU");
    const { error } = await ben.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: cat.googleSub,
    });
    expect(error).toBeNull();
    await close(ada, roundId);

    await seedRoll(roundId, ben.googleSub, 3);
    await seedRoll(roundId, cat.googleSub, 15);
    const out = await advance(ada.client, roundId);
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: cat.googleSub });

    const r = await round(roundId);
    expect(r.brewer_modifier_gain).toBe(3);
    expect(steps(r, "roll_exemption")).toHaveLength(1);
  });

  it("dice-based picks never choose an exempt player; a chosen override still can", async () => {
    // Ben's Brew IOU is cast after Ada's Loaf and names Ada: a chosen override
    // naming the exempt player wins with its own (normal) gain. Then, with the
    // overrides gone, the default lowest-roller pick is over the rollers only.
    const [ada, ben, cat] = await players("dice-a", "dice-b", "dice-c");
    const roundId = await openRound(ada, [ben, cat]);
    await castLoaf(ada, roundId);
    await forceHold(admin, ben.googleSub, "Brew IOU");
    const { error } = await ben.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: ada.googleSub,
    });
    expect(error).toBeNull();
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 3);
    await seedRoll(roundId, cat.googleSub, 15);
    const out = await advance(ada.client, roundId);
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: ada.googleSub });
    expect((await round(roundId)).brewer_modifier_gain).toBe(3);
  });

  it("an immune Loaf caster falls through to the lowest roller, never themselves", async () => {
    const [ada, ben, cat] = await players("imm-a", "imm-b", "imm-c");
    await lastCuppa(ada);
    const roundId = await openRound(ada, [ben, cat]);
    await castLoaf(ada, roundId);
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 12);
    await seedRoll(roundId, cat.googleSub, 4);
    const out = await advance(ada.client, roundId);
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: cat.googleSub });
  });

  // -----------------------------------------------------------------------
  // Countered.
  // -----------------------------------------------------------------------

  it("countered: exempt while the window is open; once it closes the caster rolls late, and effects aimed at them apply", async () => {
    const [ada, ben, cat] = await players("ctr-a", "ctr-b", "ctr-c");
    const roundId = await openRound(ada, [ben, cat]);
    const loafId = await castLoaf(ada, roundId);
    // Effects aimed at Ada before rolling must still apply once she rolls
    // late: a disadvantage (applied at roll time) and a -50 modifier (applied
    // at resolve time -- it also makes her the lowest whatever she rolls).
    for (const [donor, effectKind, effectParams] of [
      ["Tannin Tantrum", "disadvantage", {}],
      ["Lucky Sip", "flat_modifier", { delta: -50 }],
    ] as const) {
      const instanceId = await forceHold(admin, ben.googleSub, donor);
      await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", instanceId);
      const { error } = await admin.from("spell_casts").insert({
        round_id: roundId,
        caster_id: ben.googleSub,
        card_instance_id: instanceId,
        target_player_id: ada.googleSub,
        target_pending: false,
        effect_kind: effectKind,
        effect_params: effectParams,
        target_role: "TARGET",
      });
      expect(error).toBeNull();
    }
    await close(ada, roundId);

    await seedRoll(roundId, ben.googleSub, 9);
    await seedRoll(roundId, cat.googleSub, 15);
    const windowId = await openWindow(roundId);
    await counter(roundId, cat, loafId, windowId);

    // The counter can itself be countered until the window closes.
    expect(await expectedRollers(roundId, ada)).toEqual([ben.googleSub, cat.googleSub].sort());

    await closeWindow(windowId);
    expect(await expectedRollers(roundId, ada)).toEqual([ada.googleSub, ben.googleSub, cat.googleSub].sort());
    expect(await finalize(ada.client, roundId)).toMatchObject({ outcome: "noop", reason: "layer_incomplete" });

    // The late roll goes through the ordinary roll gate, with the disadvantage applied.
    const { error: rollErr } = await ada.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr).toBeNull();
    const { data: lateRoll } = await admin
      .from("rolls")
      .select("discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", ada.googleSub)
      .eq("layer", 0)
      .single();
    expect(lateRoll!.discarded_value).not.toBeNull();

    // advance_layer finds the closed window and finalizes -- no second window.
    const out = await advance(ada.client, roundId);
    expect(out).toMatchObject({ outcome: "brewer", brewer_id: ada.googleSub });
    const { data: windows } = await admin.from("spell_reaction_windows").select("id").eq("round_id", roundId);
    expect(windows).toHaveLength(1);

    const r = await round(roundId);
    expect(r.brewer_modifier_gain).toBe(3); // the countered Loaf's double gain is gone
    expect(steps(r, "roll_exemption")).toEqual([]);
  });

  it("a counter of the counter keeps the exemption: Loaf stands", async () => {
    const [ada, ben, cat] = await players("cc-a", "cc-b", "cc-c");
    const roundId = await openRound(ada, [ben, cat]);
    const loafId = await castLoaf(ada, roundId);
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 3);
    await seedRoll(roundId, cat.googleSub, 15);
    const windowId = await openWindow(roundId);
    const counterId = await counter(roundId, cat, loafId, windowId);
    await counter(roundId, ben, counterId, windowId);
    await closeWindow(windowId);

    expect(await expectedRollers(roundId, ada)).toEqual([ben.googleSub, cat.googleSub].sort());
    expect(await finalize(ada.client, roundId)).toMatchObject({ outcome: "brewer", brewer_id: ada.googleSub });
    expect((await round(roundId)).brewer_modifier_gain).toBe(6);
  });

  it("countered: the late roller's stall clock starts when the window closes, then a no-show is excluded", async () => {
    const [ada, ben, cat] = await players("stall-a", "stall-b", "stall-c");
    const roundId = await openRound(ada, [ben, cat]);
    const loafId = await castLoaf(ada, roundId);
    await close(ada, roundId);
    // Declarations closed long ago; the window only just closed.
    await admin
      .from("rounds")
      .update({ closed_at: new Date(Date.now() - 20 * 60_000).toISOString() })
      .eq("id", roundId);
    await seedRoll(roundId, ben.googleSub, 3);
    await seedRoll(roundId, cat.googleSub, 15);
    const windowId = await openWindow(roundId);
    await counter(roundId, cat, loafId, windowId);
    const windowClosedAt = new Date();
    await closeWindow(windowId, windowClosedAt);

    expect(await enforceStallTimeout(ben.client, roundId, () => new Date(windowClosedAt.getTime() + 60_000))).toEqual({
      action: "none",
    });

    const outcome = await enforceStallTimeout(ben.client, roundId, () => new Date(windowClosedAt.getTime() + 6 * 60_000));
    expect(outcome).toEqual({ action: "excluded", playerIds: [ada.googleSub] });
    expect(await round(roundId)).toMatchObject({ status: "resolved", brewer_id: ben.googleSub });
  });

  it("stall: excluding one no-show leaves the round alive while the exempt caster is still a Participant", async () => {
    const [ada, ben, cat] = await players("ns-a", "ns-b", "ns-c");
    const roundId = await openRound(ada, [ben, cat]);
    await castLoaf(ada, roundId);
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 3);

    const outcome = await enforceStallTimeout(ben.client, roundId, () => new Date(Date.now() + 6 * 60_000));
    expect(outcome).toEqual({ action: "excluded", playerIds: [cat.googleSub] });
    expect(await round(roundId)).toMatchObject({ status: "resolved", brewer_id: ada.googleSub });
  });

  // -----------------------------------------------------------------------
  // Every participant exempt.
  // -----------------------------------------------------------------------

  it("every participant exempt: the round resolves at close -- last Loaf wins", async () => {
    const [ada, ben] = await players("all-a", "all-b");
    const roundId = await openRound(ada, [ben]);
    await castLoaf(ada, roundId);
    await castLoaf(ben, roundId);
    await close(ada, roundId);

    expect(await expectedRollers(roundId, ada)).toEqual([]);
    const out = await advance(ada.client, roundId);
    expect(out).toMatchObject({ outcome: "windowOpened", window_closed: true });
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: ben.googleSub });

    const r = await round(roundId);
    expect(r.brewer_modifier_gain).toBe(4);
    expect(steps(r, "roll_exemption").map((s) => s.target_player).sort()).toEqual(
      [ada.googleSub, ben.googleSub].sort(),
    );
  });

  it("every participant exempt and immune: immunity gives way, and they roll normally in the Tie-Break Reroll", async () => {
    const [ada, ben] = await players("tie-a", "tie-b");
    await lastCuppa(ada);
    await lastCuppa(ben);
    const roundId = await openRound(ada, [ben]);
    await castLoaf(ada, roundId);
    await castLoaf(ben, roundId);
    await close(ada, roundId);

    const out = await advance(ada.client, roundId);
    expect(out.finalization).toMatchObject({ outcome: "tie" });
    expect([...out.finalization!.tied_player_ids!].sort()).toEqual([ada.googleSub, ben.googleSub].sort());
    expect(await expectedRollers(roundId, ada, 1)).toEqual([ada.googleSub, ben.googleSub].sort());

    const { error } = await ada.client.rpc("submit_roll", { p_round_id: roundId });
    expect(error).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Loose Leaf (#431): an exempt holder named Tea Maker.
  // -----------------------------------------------------------------------

  it("an exempt Loose Leaf holder named Tea Maker rolls off against the second-lowest of the other rollers", async () => {
    const [ada, ben, cat] = await players("ll-a", "ll-b", "ll-c");
    const roundId = await openRound(ada, [ben, cat]);
    await castLoaf(ada, roundId);
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 3);
    await seedRoll(roundId, cat.googleSub, 15);

    const windowId = await openWindow(roundId);
    const leaf = await forceHold(admin, ada.googleSub, "Loose Leaf");
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", leaf);
    const { error } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: ada.googleSub,
      card_instance_id: leaf,
      target_player_id: ada.googleSub,
      target_pending: false,
      effect_kind: "named_tea_maker_rolloff",
      effect_params: {},
      target_role: "CASTER",
      reaction_window_id: windowId,
    });
    expect(error).toBeNull();
    await closeWindow(windowId);

    const out = await finalize(ada.client, roundId);
    expect(out).toMatchObject({ outcome: "tie" });
    const [rolloff] = steps(await round(roundId), "named_tea_maker_rolloff");
    expect(rolloff).toMatchObject({ after: { value: "rolloff" }, rolloff_opponent_ids: [cat.googleSub] });
    expect(await expectedRollers(roundId, ada, 1)).toEqual([ada.googleSub, cat.googleSub].sort());
  });

  // -----------------------------------------------------------------------
  // Round replay.
  // -----------------------------------------------------------------------

  it("replay: the clean slate wipes the exemption, and the caster rolls normally", async () => {
    const [ada, ben] = await players("rep-a", "rep-b");
    const roundId = await openRound(ada, [ben]);
    await castLoaf(ada, roundId);
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 10);
    // Ben plays Time for Brew in the window.
    const windowId = await openWindow(roundId);
    const tfb = await forceHold(admin, ben.googleSub, "Time for Brew");
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", tfb);
    const { error: tfbErr } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: ben.googleSub,
      card_instance_id: tfb,
      target_pending: false,
      effect_kind: "round_replay",
      effect_params: {},
      reaction_window_id: windowId,
    });
    expect(tfbErr).toBeNull();
    await closeWindow(windowId);
    expect(await finalize(ada.client, roundId)).toMatchObject({ outcome: "brewer", brewer_id: ada.googleSub });

    const { error } = await ben.client.rpc("confirm_round_replay", { p_round_id: roundId });
    expect(error).toBeNull();

    expect(await expectedRollers(roundId, ada)).toEqual([ada.googleSub, ben.googleSub].sort());
  });
});
