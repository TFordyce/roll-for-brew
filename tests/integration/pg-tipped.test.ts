import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Exercises PG Tipped (issue #427,
// spec #401): "Choose a target. If they roll lower than you this round, they
// make tea regardless of anyone else. Target gains no modifier from this
// round."
//
// A tea_maker_override in mode `conditional_chosen` (condition
// `target_below_caster`, modifier_gain 0). Phase 5 compares the recorded
// layer-0 rolls: target lower -> the target brews and gains nothing;
// otherwise a "condition not met" no-op Trace step, the cast never enters the
// last-cast-wins contest, and selection falls through.
//
// Assertions are on observable outcomes only: rounds.brewer_id /
// brewer_modifier_gain, room_players.modifier and the Resolution Trace.

type TraceStep = {
  display_kind: string;
  target_player: string | null;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  override_reason?: string;
  override_condition?: string;
  target_roll?: number | null;
  caster_roll?: number | null;
};

describe.skipIf(!hasAnonTestEnv)("PG Tipped (issue #427)", () => {
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

  /** Casts `card` from `caster`'s hand at `target` through the real RPC. */
  async function cast(roundId: string, caster: Player, card: string, target: Player) {
    await forceHold(admin, caster.googleSub, card);
    const { data: castId, error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(error).toBeNull();
    return castId as string;
  }

  /** Closes the round, seeds the layer-0 rolls and finalizes layer 0. */
  async function rollAndFinalize(starter: Player, roundId: string, rolls: [Player, number][]) {
    await closeRound(starter, roundId);
    for (const [p, v] of rolls) await seedRoll(roundId, p.googleSub, v);
    const { error: wErr } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" });
    expect(wErr).toBeNull();
    const { data, error } = await starter.client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { outcome: string; brewer_id?: string };
  }

  async function round(roundId: string) {
    const { data, error } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made, brewer_modifier_gain, resolution_trace")
      .eq("id", roundId)
      .single();
    expect(error).toBeNull();
    return data as {
      status: string;
      brewer_id: string | null;
      cups_made: number;
      brewer_modifier_gain: number | null;
      resolution_trace: TraceStep[] | null;
    };
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

  /**
   * An earlier `chosen` tea_maker_override naming `chosen`, seeded straight
   * into the Cast Log the way the #425 tests do (no live card casts a plain
   * `chosen` override at a player), backdated so PG Tipped is the later cast.
   */
  async function seedEarlierChosenOverride(roundId: string, caster: Player, chosen: Player) {
    const donor = await forceHold(admin, caster.googleSub, "Drip Tray");
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", donor);
    const { error } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: caster.googleSub,
      card_instance_id: donor,
      target_player_id: chosen.googleSub,
      target_pending: false,
      effect_kind: "tea_maker_override",
      effect_params: { mode: "chosen" },
      cast_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(error).toBeNull();
  }

  function overrideSteps(trace: TraceStep[] | null) {
    return (trace ?? []).filter((s) => s.display_kind === "tea_maker_override");
  }

  it("is un-benched with a conditional_chosen effect row", async () => {
    const { data: card, error: cardErr } = await admin
      .from("spell_cards")
      .select("id, spell_card_effects(target_role, effect_kind, effect_params)")
      .eq("name", "PG Tipped")
      .single();
    expect(cardErr).toBeNull();
    expect(card!.spell_card_effects).toEqual([
      {
        target_role: "TARGET",
        effect_kind: "tea_maker_override",
        effect_params: { mode: "conditional_chosen", condition: "target_below_caster", modifier_gain: 0 },
      },
    ]);

    const { data: inst, error: instErr } = await admin
      .from("spell_deck_instances")
      .select("location")
      .eq("card_id", card!.id)
      .single();
    expect(instErr).toBeNull();
    expect(inst!.location).not.toBe("benched");
  });

  it("target rolls lower than the caster: the target brews and gains nothing", async () => {
    const [caster, target, low] = await Promise.all([
      signUp("pg-met-caster"),
      signUp("pg-met-target"),
      signUp("pg-met-low"),
    ]);
    const roundId = await startRound(caster, [target, low]);
    const castId = await cast(roundId, caster, "PG Tipped", target);

    // `low` would brew by default; PG Tipped forces the target instead.
    const fin = await rollAndFinalize(caster, roundId, [[caster, 15], [target, 8], [low, 2]]);
    expect(fin).toMatchObject({ outcome: "brewer", brewer_id: target.googleSub });

    const r = await round(roundId);
    expect(r).toMatchObject({ status: "resolved", brewer_id: target.googleSub, cups_made: 3, brewer_modifier_gain: 0 });
    expect(await liveModifier(target)).toBe(0);
    expect(await liveModifier(low)).toBe(0);

    expect(overrideSteps(r.resolution_trace)).toEqual([
      expect.objectContaining({
        target_player: target.googleSub,
        source_cast: expect.objectContaining({ cast_id: castId, card_name: "PG Tipped", caster_player_id: caster.googleSub }),
        after: { type: "status", value: "brewer (no modifier gain)" },
        outcome: "applied",
      }),
    ]);
  });

  it.each([
    ["equal", 10],
    ["higher", 14],
  ])("target rolls %s: a no-op Trace step and the normal pick stands", async (label, targetRoll) => {
    const [caster, target, low] = await Promise.all([
      signUp(`pg-${label}-caster`),
      signUp(`pg-${label}-target`),
      signUp(`pg-${label}-low`),
    ]);
    const roundId = await startRound(caster, [target, low]);
    const castId = await cast(roundId, caster, "PG Tipped", target);

    const fin = await rollAndFinalize(caster, roundId, [[caster, 10], [target, targetRoll], [low, 2]]);
    expect(fin).toMatchObject({ outcome: "brewer", brewer_id: low.googleSub });

    const r = await round(roundId);
    // Normal pick, normal gain (cups_made).
    expect(r).toMatchObject({ status: "resolved", brewer_id: low.googleSub, cups_made: 3, brewer_modifier_gain: 3 });
    expect(await liveModifier(low)).toBe(3);

    expect(overrideSteps(r.resolution_trace)).toEqual([
      expect.objectContaining({
        target_player: target.googleSub,
        source_cast: expect.objectContaining({ cast_id: castId, card_name: "PG Tipped" }),
        before: { type: "status", value: "pending" },
        after: { type: "status", value: "condition not met" },
        outcome: "no-op",
        override_reason: "condition_not_met",
        override_condition: "target_below_caster",
        target_roll: targetRoll,
        caster_roll: 10,
      }),
    ]);
  });

  it("a failed condition doesn't beat an earlier override in the last-cast-wins contest", async () => {
    const [chooser, pg, chosen, pgTarget] = await Promise.all([
      signUp("pg-contest-chooser"),
      signUp("pg-contest-pg"),
      signUp("pg-contest-chosen"),
      signUp("pg-contest-pgtarget"),
    ]);
    const roundId = await startRound(chooser, [pg, chosen, pgTarget]);

    await seedEarlierChosenOverride(roundId, chooser, chosen);
    const pgCastId = await cast(roundId, pg, "PG Tipped", pgTarget);

    // PG Tipped's target out-rolls its caster: the condition fails.
    const fin = await rollAndFinalize(chooser, roundId, [[chooser, 3], [pg, 6], [chosen, 18], [pgTarget, 12]]);
    expect(fin).toMatchObject({ outcome: "brewer", brewer_id: chosen.googleSub });

    const r = await round(roundId);
    expect(r).toMatchObject({ brewer_id: chosen.googleSub, brewer_modifier_gain: 4 });

    const steps = overrideSteps(r.resolution_trace);
    expect(steps.map((s) => [s.source_cast.card_name, s.target_player, s.after.value, s.outcome])).toEqual([
      ["PG Tipped", pgTarget.googleSub, "condition not met", "no-op"],
      ["Drip Tray", chosen.googleSub, "brewer", "applied"],
    ]);
    expect(steps[0]!.source_cast.cast_id).toBe(pgCastId);
  });

  it("a met condition beats an earlier override (last cast wins)", async () => {
    const [chooser, pg, chosen, pgTarget] = await Promise.all([
      signUp("pg-win-chooser"),
      signUp("pg-win-pg"),
      signUp("pg-win-chosen"),
      signUp("pg-win-pgtarget"),
    ]);
    const roundId = await startRound(chooser, [pg, chosen, pgTarget]);

    await seedEarlierChosenOverride(roundId, chooser, chosen);
    await cast(roundId, pg, "PG Tipped", pgTarget);

    const fin = await rollAndFinalize(chooser, roundId, [[chooser, 3], [pg, 16], [chosen, 18], [pgTarget, 12]]);
    expect(fin).toMatchObject({ outcome: "brewer", brewer_id: pgTarget.googleSub });

    const r = await round(roundId);
    expect(r).toMatchObject({ brewer_id: pgTarget.googleSub, brewer_modifier_gain: 0 });
    // The earlier override never entered: only PG Tipped's step.
    expect(overrideSteps(r.resolution_trace).map((s) => s.source_cast.card_name)).toEqual(["PG Tipped"]);
  });
});
