import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #434 (spec #401): Tea Cosy --
// "You are exempt from rolling this round. You cannot be the tea-maker."
//
//   * One catalog effect row, CASTER / brewer_immunity {mode: 'tea_cosy',
//     exempt_from_rolling: true}, on a card whose duration_rounds is 1. The
//     cast promotes a one-round, dispellable brewer_immunity row (Brewer
//     Immunity, #428) and carries the Roll Exemption flag (#433).
//   * Countered: both halves go -- the source cast is negated, so the
//     immunity isn't live, and the caster rolls late once the window closes.
//   * A Round replay's clean slate deletes the cast: no exemption, no
//     immunity.
//   * Every participant on Tea Cosy: no layer-0 roll is expected, the round
//     resolves at close, and immunity gives way to a Tie-Break Reroll.
// Assertions are on observable outcomes: who is expected to roll, the
// brewer, and the Resolution Trace.

type TraceStep = {
  display_kind: string;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  immunity_tier?: string | null;
  skipped_card_name?: string | null;
  negated?: boolean;
};

type RoundRow = {
  status: string;
  current_layer: number;
  brewer_id: string | null;
  resolution_trace: TraceStep[] | null;
};

const COSY = "Tea Cosy";

describe.skipIf(!hasAnonTestEnv)("Tea Cosy (#434)", () => {
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
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `cosy-${l}`)));
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
      brewer_id?: string;
      tied_player_ids?: string[];
      window_closed?: boolean;
      finalization?: { outcome: string; brewer_id?: string; tied_player_ids?: string[] } | null;
    };
  }

  async function finalize(client: SupabaseClient, roundId: string) {
    const { data, error } = await client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { outcome: string; reason?: string; brewer_id?: string };
  }

  /** Tea Cosy, cast for real through cast_spell_card while `roundId` is open. */
  async function castCosy(caster: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, COSY);
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  /** A chosen override (Brew IOU) from `caster` naming `target`. */
  async function brewIou(caster: Player, roundId: string, target: Player) {
    await forceHold(admin, caster.googleSub, "Brew IOU");
    const { error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(error).toBeNull();
  }

  async function expectedRollers(roundId: string, as: Player, layer = 0) {
    const { data, error } = await as.client.rpc("get_expected_layer_roller_ids", { p_round_id: roundId, p_layer: layer });
    expect(error).toBeNull();
    return (data as { player_id: string }[]).map((r) => r.player_id).sort();
  }

  async function round(roundId: string): Promise<RoundRow> {
    const { data, error } = await admin
      .from("rounds")
      .select("status, current_layer, brewer_id, resolution_trace")
      .eq("id", roundId)
      .single();
    expect(error).toBeNull();
    return data as RoundRow;
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

  async function closeWindow(windowId: string) {
    const { error } = await admin
      .from("spell_reaction_windows")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", windowId);
    expect(error).toBeNull();
  }

  /** Seeds a Reaction-window cast of `donor` by `caster` (the card goes back to the deck). */
  async function seedWindowCast(
    roundId: string,
    caster: Player,
    donor: string,
    row: {
      effect_kind: string;
      effect_params?: object;
      cast_inputs?: object;
      parent_cast_id?: string;
      target_player_id?: string | null;
      target_role?: string;
    },
    windowId: string | null,
  ) {
    const instanceId = await forceHold(admin, caster.googleSub, donor);
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", instanceId);
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: caster.googleSub,
        card_instance_id: instanceId,
        target_player_id: row.target_player_id ?? null,
        target_pending: false,
        effect_kind: row.effect_kind,
        effect_params: row.effect_params ?? {},
        cast_inputs: row.cast_inputs ?? null,
        parent_cast_id: row.parent_cast_id ?? null,
        target_role: row.target_role ?? null,
        reaction_window_id: windowId,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  const steps = (r: RoundRow, kind: string) => (r.resolution_trace ?? []).filter((s) => s.display_kind === kind);

  // -----------------------------------------------------------------------
  // The card.
  // -----------------------------------------------------------------------

  it("is un-benched, with one CASTER brewer_immunity row (tea_cosy, exempt from rolling) lasting one round", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", COSY)
      .single();
    expect(inst!.location).not.toBe("benched");

    const { data: card } = await admin.from("spell_cards").select("duration_rounds").eq("name", COSY).single();
    expect(card!.duration_rounds).toBe(1);

    const { data: effects } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params, spell_cards!inner(name)")
      .eq("spell_cards.name", COSY);
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      target_role: "CASTER",
      effect_kind: "brewer_immunity",
      effect_params: { mode: "tea_cosy", exempt_from_rolling: true },
    });
  });

  it("casting it promotes a one-round, dispellable brewer_immunity row on the caster", async () => {
    const [ada, ben] = await players("row-a", "row-b");
    const roundId = await openRound(ada, [ben]);
    const castId = await castCosy(ada, roundId);

    const { data: rows } = await admin
      .from("spell_active_effects")
      .select("id, target_player_id, effect_kind, effect_params, rounds_remaining, is_undispellable")
      .eq("source_cast_id", castId);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({
      target_player_id: ada.googleSub,
      effect_kind: "brewer_immunity",
      effect_params: { mode: "tea_cosy" },
      rounds_remaining: 1,
      is_undispellable: false,
    });

    await forceHold(admin, ben.googleSub, "Greater Detox");
    const { data: offered, error } = await ben.client.rpc("get_dispellable_active_effects", { p_round_id: roundId });
    expect(error).toBeNull();
    expect((offered as { effect_id: string }[]).map((x) => x.effect_id)).toContain(rows![0]!.id);
  });

  // -----------------------------------------------------------------------
  // The Tea Cosy round.
  // -----------------------------------------------------------------------

  it("the caster has no layer-0 roll; the round completes without it; the lowest roller brews", async () => {
    const [ada, ben, cat] = await players("skip-a", "skip-b", "skip-c");
    const roundId = await openRound(ada, [ben, cat]);
    const castId = await castCosy(ada, roundId);
    await close(ada, roundId);

    expect(await expectedRollers(roundId, ada)).toEqual([ben.googleSub, cat.googleSub].sort());
    const { error: rollErr } = await ada.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr?.message).toMatch(/not expected to roll/);

    await seedRoll(roundId, ben.googleSub, 3);
    await seedRoll(roundId, cat.googleSub, 15);
    const out = await advance(ada.client, roundId);
    expect(out).toMatchObject({ outcome: "windowOpened", window_closed: true });
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: ben.googleSub });

    const r = await round(roundId);
    expect(r).toMatchObject({ status: "resolved", brewer_id: ben.googleSub });
    expect(steps(r, "roll_exemption")).toHaveLength(1);
    expect(steps(r, "roll_exemption")[0]).toMatchObject({
      source_cast: { cast_id: castId, card_name: COSY, caster_player_id: ada.googleSub },
      target_player: ada.googleSub,
      after: { type: "status", value: "skipped" },
    });
  });

  it("an override naming the caster can't make them brew: it falls through to the lowest roller", async () => {
    const [ada, ben, cat] = await players("ovr-a", "ovr-b", "ovr-c");
    const roundId = await openRound(ada, [ben, cat]);
    await castCosy(ada, roundId);
    await brewIou(ben, roundId, ada);
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 12);
    await seedRoll(roundId, cat.googleSub, 4);

    const out = await advance(ada.client, roundId);
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: cat.googleSub });

    const [skip] = steps(await round(roundId), "brewer_immunity");
    expect(skip).toMatchObject({
      source_cast: { card_name: COSY, caster_player_id: ada.googleSub },
      target_player: ada.googleSub,
      after: { type: "status", value: "immune" },
      immunity_tier: "tea_maker_override",
      skipped_card_name: "Brew IOU",
    });
  });

  it("the caster's own Loaf of Lipton can't make them brew either", async () => {
    // Exempt twice over, and the `chosen` self-override names an immune player.
    const [ada, ben] = await players("loaf-a", "loaf-b");
    const roundId = await openRound(ada, [ben]);
    await castCosy(ada, roundId);
    await seedWindowCast(
      roundId,
      ada,
      "Loaf of Lipton",
      {
        effect_kind: "tea_maker_override",
        effect_params: { mode: "chosen", modifier_gain_multiplier: 2, exempt_from_rolling: true },
        target_player_id: ada.googleSub,
        target_role: "CASTER",
      },
      null,
    );
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 18);

    const out = await advance(ada.client, roundId);
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: ben.googleSub });
  });

  it("the immunity is gone next round: the caster rolls and can brew", async () => {
    const [ada, ben] = await players("next-a", "next-b");
    const r1 = await openRound(ada, [ben]);
    await castCosy(ada, r1);
    await close(ada, r1);
    await seedRoll(r1, ben.googleSub, 10);
    expect((await advance(ada.client, r1)).finalization).toMatchObject({ outcome: "brewer", brewer_id: ben.googleSub });

    const r2 = await openRound(ada, [ben]);
    await close(ada, r2);
    expect(await expectedRollers(r2, ada)).toEqual([ada.googleSub, ben.googleSub].sort());
    await seedRoll(r2, ada.googleSub, 2);
    await seedRoll(r2, ben.googleSub, 15);
    const out = await advance(ada.client, r2);
    expect(out.finalization).toMatchObject({ outcome: "brewer", brewer_id: ada.googleSub });
    expect(steps(await round(r2), "brewer_immunity")).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Countered.
  // -----------------------------------------------------------------------

  it("countered: no immunity and a late roll -- the caster rolls once the window closes and can brew", async () => {
    const [ada, ben, cat] = await players("ctr-a", "ctr-b", "ctr-c");
    const roundId = await openRound(ada, [ben, cat]);
    const cosyId = await castCosy(ada, roundId);
    // A -50 modifier on Ada (applied at resolve time) makes her the lowest
    // whatever she rolls late: only her immunity could save her.
    await seedWindowCast(
      roundId,
      ben,
      "Lucky Sip",
      { effect_kind: "flat_modifier", effect_params: { delta: -50 }, target_player_id: ada.googleSub, target_role: "TARGET" },
      null,
    );
    await close(ada, roundId);

    await seedRoll(roundId, ben.googleSub, 9);
    await seedRoll(roundId, cat.googleSub, 15);
    const windowId = await openWindow(roundId);
    await seedWindowCast(
      roundId,
      cat,
      "Tannin Tantrum",
      { effect_kind: "contested_negate", cast_inputs: { dc_d20: 20 }, parent_cast_id: cosyId },
      windowId,
    );
    expect(await expectedRollers(roundId, ada)).toEqual([ben.googleSub, cat.googleSub].sort());

    await closeWindow(windowId);
    expect(await expectedRollers(roundId, ada)).toEqual([ada.googleSub, ben.googleSub, cat.googleSub].sort());
    expect(await finalize(ada.client, roundId)).toMatchObject({ outcome: "noop", reason: "layer_incomplete" });

    const { error: rollErr } = await ada.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr).toBeNull();

    const out = await advance(ada.client, roundId);
    expect(out).toMatchObject({ outcome: "brewer", brewer_id: ada.googleSub });

    const r = await round(roundId);
    expect(steps(r, "roll_exemption")).toEqual([]);
    // Only the countered cast's own Phase 1 step ("Ada's brewer immunity was
    // negated"); no immunity skip.
    expect(steps(r, "brewer_immunity")).toEqual([
      expect.objectContaining({ target_player: ada.googleSub, negated: true, after: { type: "status", value: "negated" } }),
    ]);
  });

  // -----------------------------------------------------------------------
  // Every participant on Tea Cosy.
  // -----------------------------------------------------------------------

  it("every participant on Tea Cosy: resolved at close, immunity gives way to a Tie-Break Reroll among everyone", async () => {
    const [ada, ben, cat] = await players("all-a", "all-b", "all-c");
    const roundId = await openRound(ada, [ben, cat]);
    await castCosy(ada, roundId);
    await castCosy(ben, roundId);
    await castCosy(cat, roundId);
    await close(ada, roundId);

    const everyone = [ada.googleSub, ben.googleSub, cat.googleSub].sort();
    expect(await expectedRollers(roundId, ada)).toEqual([]);
    const out = await advance(ada.client, roundId);
    expect(out).toMatchObject({ outcome: "windowOpened", window_closed: true });
    expect(out.finalization).toMatchObject({ outcome: "tie" });
    expect([...out.finalization!.tied_player_ids!].sort()).toEqual(everyone);

    const r = await round(roundId);
    expect(steps(r, "roll_exemption").map((s) => s.target_player).sort()).toEqual(everyone);
    expect(steps(r, "brewer_immunity")).toEqual([
      expect.objectContaining({ immunity_tier: "all_immune", after: { type: "status", value: "tie" } }),
    ]);

    // Everyone rolls the Tie-Break Reroll normally; the lowest brews.
    expect(await expectedRollers(roundId, ada, 1)).toEqual(everyone);
    await seedRoll(roundId, ada.googleSub, 14, 1);
    await seedRoll(roundId, ben.googleSub, 3, 1);
    await seedRoll(roundId, cat.googleSub, 9, 1);
    const tieOut = await advance(ada.client, roundId);
    const brewer = tieOut.finalization?.brewer_id ?? tieOut.brewer_id;
    expect(brewer).toBe(ben.googleSub);
    expect(await round(roundId)).toMatchObject({ status: "resolved", brewer_id: ben.googleSub });
  });

  // -----------------------------------------------------------------------
  // Round replay.
  // -----------------------------------------------------------------------

  it("replay: the cast is gone -- the caster rolls normally and has no immunity", async () => {
    const [ada, ben] = await players("rep-a", "rep-b");
    const roundId = await openRound(ada, [ben]);
    await castCosy(ada, roundId);
    await close(ada, roundId);
    await seedRoll(roundId, ben.googleSub, 10);
    // Ben plays Time for Brew in the window.
    const windowId = await openWindow(roundId);
    await seedWindowCast(roundId, ben, "Time for Brew", { effect_kind: "round_replay" }, windowId);
    await closeWindow(windowId);
    expect(await finalize(ada.client, roundId)).toMatchObject({ outcome: "brewer", brewer_id: ben.googleSub });

    const { error } = await ben.client.rpc("confirm_round_replay", { p_round_id: roundId });
    expect(error).toBeNull();

    expect(await expectedRollers(roundId, ada)).toEqual([ada.googleSub, ben.googleSub].sort());
    await seedRoll(roundId, ada.googleSub, 2);
    await seedRoll(roundId, ben.googleSub, 15);
    const { data: outcome, error: resErr } = await ada.client.rpc("resolve_round", { p_round_id: roundId });
    expect(resErr).toBeNull();
    expect(outcome).toMatchObject({ outcome: "brewer", brewer_id: ada.googleSub });
    const trace = (outcome as { trace: TraceStep[] }).trace;
    expect(trace.filter((s) => s.display_kind === "brewer_immunity")).toEqual([]);
    expect(trace.filter((s) => s.display_kind === "roll_exemption")).toEqual([]);
  });
});
