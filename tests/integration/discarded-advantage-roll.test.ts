import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, forceHold, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises
// 0049_persist_discarded_advantage_disadvantage_roll.sql (issue #164): the
// second d20 rolled to resolve advantage/disadvantage used to be thrown
// away — submit_roll/submit_roll_as now persist it to rolls.discarded_value
// so the UI can later show it struck-through next to the kept roll.
describe.skipIf(!hasAnonTestEnv)("discarded advantage/disadvantage roll (issue #164)", () => {
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

  it("persists the discarded roll when disadvantage applies, and it's the losing side of the two d20s", async () => {
    const caster = await signUp("discard-disadv-caster");
    const target = await signUp("discard-disadv-target");
    await forceHold(admin, caster.googleSub, "Slipped Spoon");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    // Slipped Spoon: target gets disadvantage, caster gets a 1d4 bonus.
    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castError).toBeNull();

    await caster.client.rpc("close_round", { p_round_id: roundId });

    const { error: targetRollError } = await target.client.rpc("submit_roll", { p_round_id: roundId });
    expect(targetRollError).toBeNull();

    const { data: targetRoll, error: readError } = await admin
      .from("rolls")
      .select("value, discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", target.googleSub)
      .single();
    expect(readError).toBeNull();

    // Disadvantage keeps the lower of the two d20s.
    expect(targetRoll!.discarded_value).not.toBeNull();
    expect(targetRoll!.discarded_value).toBeGreaterThanOrEqual(1);
    expect(targetRoll!.discarded_value).toBeLessThanOrEqual(20);
    expect(targetRoll!.value).toBeLessThanOrEqual(targetRoll!.discarded_value as number);

    // The caster rolled with no advantage/disadvantage this round — nothing
    // to discard.
    const { error: casterRollError } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
    expect(casterRollError).toBeNull();

    const { data: casterRoll, error: casterReadError } = await admin
      .from("rolls")
      .select("discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", caster.googleSub)
      .single();
    expect(casterReadError).toBeNull();
    expect(casterRoll!.discarded_value).toBeNull();
  });

  it("persists the discarded roll when advantage applies, and it's the losing side of the two d20s", async () => {
    const caster = await signUp("discard-adv-caster");
    const other = await signUp("discard-adv-other");
    await forceHold(admin, caster.googleSub, "Sugar Rush");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    // Sugar Rush: self-targeted, grants the caster advantage.
    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    const { error: closeError } = await caster.client.rpc("close_round", { p_round_id: roundId });
    expect(closeError).toBeNull();

    const { error: rollError } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollError).toBeNull();

    const { data: roll, error: readError } = await admin
      .from("rolls")
      .select("value, discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", caster.googleSub)
      .single();
    expect(readError).toBeNull();

    // Advantage keeps the higher of the two d20s.
    expect(roll!.discarded_value).not.toBeNull();
    expect(roll!.discarded_value).toBeGreaterThanOrEqual(1);
    expect(roll!.discarded_value).toBeLessThanOrEqual(20);
    expect(roll!.value).toBeGreaterThanOrEqual(roll!.discarded_value as number);
  });

  it("records the advantage roll transform into cast_inputs — kept high of two recorded d20s (issue #306)", async () => {
    const caster = await signUp("adv-castinputs-caster");
    const other = await signUp("adv-castinputs-other");
    await forceHold(admin, caster.googleSub, "Sugar Rush");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: null });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await caster.client.rpc("submit_roll", { p_round_id: roundId });

    const { data: roll } = await admin
      .from("rolls")
      .select("value")
      .eq("round_id", roundId)
      .eq("player_id", caster.googleSub)
      .single();

    const { data: cast } = await admin
      .from("spell_casts")
      .select("effect_kind, cast_inputs")
      .eq("round_id", roundId)
      .eq("effect_kind", "advantage")
      .single();

    const rt = (cast!.cast_inputs as { roll_transform?: Record<string, unknown> }).roll_transform!;
    expect(rt.kind).toBe("advantage");
    expect(rt.order).toBe(1);
    expect(rt.cancelled).toBe(false);
    const dice = rt.dice as number[];
    expect(dice).toHaveLength(2);
    const players = rt.players as { player_id: string; before: number; after: number }[];
    expect(players).toHaveLength(1);
    expect(players[0]!.player_id).toBe(caster.googleSub);
    // Kept value == the high of the two d20s == what landed in rolls.value.
    expect(players[0]!.after).toBe(Math.max(...dice));
    expect(players[0]!.after).toBe(roll!.value);
    expect(players[0]!.before).toBe(dice[0]);
  });

  it("records the disadvantage roll transform into cast_inputs — kept low of two recorded d20s (issue #306)", async () => {
    const caster = await signUp("disadv-castinputs-caster");
    const target = await signUp("disadv-castinputs-target");
    await forceHold(admin, caster.googleSub, "Slipped Spoon");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    // Slipped Spoon: target gets disadvantage, caster gets a 1d4 bonus.
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: target.googleSub });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await target.client.rpc("submit_roll", { p_round_id: roundId });

    const { data: roll } = await admin
      .from("rolls")
      .select("value")
      .eq("round_id", roundId)
      .eq("player_id", target.googleSub)
      .single();

    const { data: cast } = await admin
      .from("spell_casts")
      .select("effect_kind, cast_inputs")
      .eq("round_id", roundId)
      .eq("effect_kind", "disadvantage")
      .single();

    const rt = (cast!.cast_inputs as { roll_transform?: Record<string, unknown> }).roll_transform!;
    expect(rt.kind).toBe("disadvantage");
    expect(rt.order).toBe(1);
    expect(rt.cancelled).toBe(false);
    const dice = rt.dice as number[];
    expect(dice).toHaveLength(2);
    const players = rt.players as { player_id: string; before: number; after: number }[];
    expect(players).toHaveLength(1);
    expect(players[0]!.player_id).toBe(target.googleSub);
    // Kept value == the low of the two d20s == what landed in rolls.value.
    expect(players[0]!.after).toBe(Math.min(...dice));
    expect(players[0]!.after).toBe(roll!.value);
    expect(players[0]!.before).toBe(dice[0]);
  });

  it("advantage + disadvantage on one player cancel to a single d20, recorded on both cast rows (issue #306)", async () => {
    const caster = await signUp("adv-cancel-caster");
    const other = await signUp("adv-cancel-other");
    // Sugar Rush gives the caster self-advantage; add a hand-seeded
    // disadvantage cast on the same player so the two cancel in submit_roll.
    const advInstance = await forceHold(admin, caster.googleSub, "Sugar Rush");
    // A second, unheld instance to satisfy the disadvantage cast's FK — a
    // player can only hold one card at a time
    // (spell_deck_instances_one_held_per_player), so this one is never held.
    const { data: milkyCard } = await admin.from("spell_cards").select("id").eq("name", "Milky Brew").single();
    const { data: disRow } = await admin
      .from("spell_deck_instances")
      .select("id")
      .eq("card_id", milkyCard!.id)
      .single();
    const disInstance = disRow!.id as string;

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    // Cast Sugar Rush (creates the real 'advantage' cast + consumes advInstance).
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: null });
    expect(advInstance).toBeTruthy();
    // Hand-seed the opposing disadvantage cast on the caster.
    await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: caster.googleSub,
      card_instance_id: disInstance,
      target_player_id: caster.googleSub,
      target_pending: false,
      effect_kind: "disadvantage",
      effect_params: {},
    });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await caster.client.rpc("submit_roll", { p_round_id: roundId });

    const { data: roll } = await admin
      .from("rolls")
      .select("value, discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", caster.googleSub)
      .single();
    // Cancelled -> a single unmodified d20, nothing discarded.
    expect(roll!.discarded_value).toBeNull();

    const { data: casts } = await admin
      .from("spell_casts")
      .select("effect_kind, cast_inputs")
      .eq("round_id", roundId)
      .in("effect_kind", ["advantage", "disadvantage"]);
    expect(casts).toHaveLength(2);
    for (const c of casts as { effect_kind: string; cast_inputs: { roll_transform?: Record<string, unknown> } }[]) {
      const rt = c.cast_inputs.roll_transform!;
      expect(rt.cancelled).toBe(true);
      expect((rt.dice as number[])).toHaveLength(1);
      const p = (rt.players as { before: number; after: number }[])[0]!;
      expect(p.before).toBe(p.after);
      expect(p.after).toBe(roll!.value);
    }
  });

  it("surfaces discarded_value through get_current_layer_rolls_if_complete (issue #167, migration 0051)", async () => {
    const caster = await signUp("discard-rpc-caster");
    const other = await signUp("discard-rpc-other");
    await forceHold(admin, caster.googleSub, "Sugar Rush");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    await caster.client.rpc("close_round", { p_round_id: roundId });

    const { error: casterRollError } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
    expect(casterRollError).toBeNull();
    const { error: otherRollError } = await other.client.rpc("submit_roll", { p_round_id: roundId });
    expect(otherRollError).toBeNull();

    const { data: rows, error: rowsError } = await caster.client.rpc("get_current_layer_rolls_if_complete", {
      p_round_id: roundId,
    });
    expect(rowsError).toBeNull();

    const typedRows = rows as { player_id: string; value: number; discarded_value: number | null }[];
    const casterRow = typedRows.find((r) => r.player_id === caster.googleSub);
    const otherRow = typedRows.find((r) => r.player_id === other.googleSub);

    // Advantage keeps the higher of the two d20s for the caster; the other
    // player had no advantage/disadvantage this round.
    expect(casterRow?.discarded_value).not.toBeNull();
    expect(casterRow!.value).toBeGreaterThanOrEqual(casterRow!.discarded_value as number);
    expect(otherRow?.discarded_value).toBeNull();
  });

  // submit_roll_as (0029_admin_roll_as.sql) carries the exact same
  // advantage/disadvantage resolution block as submit_roll — the two are
  // kept in lockstep by convention (see 0031's own duplication of this
  // logic) — but exercising the admin-puppeting-a-Test-Room-player path has
  // no existing integration-test harness in this suite to build on, so it's
  // left uncovered here rather than hand-rolling untested setup code. The
  // two tests above already prove the shared resolution logic itself is
  // correct for both the advantage and disadvantage branches.
});
