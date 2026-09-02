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
    const [caster, target] = await Promise.all([
      signUp("discard-disadv-caster"),
      signUp("discard-disadv-target"),
    ]);
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
    const [caster, other] = await Promise.all([
      signUp("discard-adv-caster"),
      signUp("discard-adv-other"),
    ]);
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
    const [caster, other] = await Promise.all([
      signUp("discard-rpc-caster"),
      signUp("discard-rpc-other"),
    ]);
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

  // ------------------------------------------------------------------
  // Conditional advantage — Gambler's Infusion (issue #319). The shim
  // evaluates a `condition` param against the first d20 and folds the chosen
  // branch into the ordinary advantage/disadvantage resolution, recording it
  // into cast_inputs.roll_transform.condition.
  // ------------------------------------------------------------------
  it("cast_spell_card copies the condition param onto the cast row, and submit_roll records the branch", async () => {
    const [caster, other] = await Promise.all([
      signUp("gambler-e2e-caster"),
      signUp("gambler-e2e-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Gambler's Infusion");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    // The real path: hold the card, cast it (SELF), let cast_spell_card's
    // generic effect loop copy the spell_card_effects row.
    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    const { data: castRow } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, target_player_id, target_pending")
      .eq("round_id", roundId)
      .single();
    expect(castRow!.effect_kind).toBe("advantage");
    expect(castRow!.target_player_id).toBe(caster.googleSub);
    expect(castRow!.target_pending).toBe(false);
    expect((castRow!.effect_params as { condition?: Record<string, number> }).condition).toEqual({
      advantage_at_or_above: 15,
      disadvantage_at_or_below: 5,
    });

    await caster.client.rpc("close_round", { p_round_id: roundId });
    const { error: rollErr } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollErr).toBeNull();

    const { data: roll } = await admin
      .from("rolls").select("value, discarded_value")
      .eq("round_id", roundId).eq("player_id", caster.googleSub).single();
    const { data: cast } = await admin
      .from("spell_casts").select("cast_inputs")
      .eq("round_id", roundId).eq("effect_kind", "advantage").single();

    const rt = (cast!.cast_inputs as { roll_transform?: Record<string, unknown> }).roll_transform!;
    const cond = rt.condition as { first_die: number; branch: "advantage" | "disadvantage" | "none" };
    expect(cond.first_die).toBeGreaterThanOrEqual(1);
    expect(cond.first_die).toBeLessThanOrEqual(20);
    const players = rt.players as { player_id: string; before: number; after: number }[];
    expect(players[0]!.player_id).toBe(caster.googleSub);
    expect(players[0]!.before).toBe(cond.first_die);
    expect(players[0]!.after).toBe(roll!.value);

    if (cond.first_die >= 15) {
      expect(cond.branch).toBe("advantage");
      expect(players[0]!.after).toBe(Math.max(...(rt.dice as number[])));
    } else if (cond.first_die <= 5) {
      expect(cond.branch).toBe("disadvantage");
      expect(players[0]!.after).toBe(Math.min(...(rt.dice as number[])));
    } else {
      expect(cond.branch).toBe("none");
      expect(players[0]!.after).toBe(cond.first_die);
      expect(roll!.discarded_value).toBeNull();
    }
  });

  it("records the branch the first die selected, consistently, across many rounds", async () => {
    const [caster, other] = await Promise.all([
      signUp("gambler-shim-caster"),
      signUp("gambler-shim-other"),
    ]);
    const instanceId = await forceHold(admin, caster.googleSub, "Gambler's Infusion");

    const seenBranches = new Set<string>();
    const ITERATIONS = 20;

    for (let i = 0; i < ITERATIONS; i++) {
      const { data: roundId } = await caster.client.rpc("start_round");
      await other.client.rpc("declare_in", { p_round_id: roundId });

      // Seed the conditional-advantage cast directly (skips cast_spell_card's
      // ceremony; the shim only cares about the row's effect_kind + params).
      const { error: castErr } = await admin.from("spell_casts").insert({
        round_id: roundId,
        caster_id: caster.googleSub,
        card_instance_id: instanceId,
        target_player_id: caster.googleSub,
        target_pending: false,
        effect_kind: "advantage",
        effect_params: { condition: { advantage_at_or_above: 15, disadvantage_at_or_below: 5 } },
      });
      expect(castErr).toBeNull();

      await caster.client.rpc("close_round", { p_round_id: roundId });
      const { error: rollErr } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
      expect(rollErr).toBeNull();

      const { data: roll } = await admin
        .from("rolls")
        .select("value, discarded_value")
        .eq("round_id", roundId)
        .eq("player_id", caster.googleSub)
        .single();

      const { data: cast } = await admin
        .from("spell_casts")
        .select("cast_inputs")
        .eq("round_id", roundId)
        .eq("effect_kind", "advantage")
        .single();

      const rt = (cast!.cast_inputs as { roll_transform?: Record<string, unknown> }).roll_transform!;
      expect(rt.kind).toBe("advantage");
      expect(rt.order).toBe(1);
      expect(rt.cancelled).toBe(false);

      const cond = rt.condition as {
        first_die: number;
        branch: "advantage" | "disadvantage" | "none";
        advantage_at_or_above: number;
        disadvantage_at_or_below: number;
      };
      expect(cond.advantage_at_or_above).toBe(15);
      expect(cond.disadvantage_at_or_below).toBe(5);
      expect(cond.first_die).toBeGreaterThanOrEqual(1);
      expect(cond.first_die).toBeLessThanOrEqual(20);

      const dice = rt.dice as number[];
      const player = (rt.players as { player_id: string; before: number; after: number }[])[0]!;
      expect(player.player_id).toBe(caster.googleSub);
      expect(player.before).toBe(cond.first_die);
      expect(player.before).toBe(dice[0]);
      expect(player.after).toBe(roll!.value);

      if (cond.first_die >= 15) {
        expect(cond.branch).toBe("advantage");
        expect(dice).toHaveLength(2);
        expect(player.after).toBe(Math.max(...dice));
        expect(roll!.discarded_value).toBe(Math.min(...dice));
      } else if (cond.first_die <= 5) {
        expect(cond.branch).toBe("disadvantage");
        expect(dice).toHaveLength(2);
        expect(player.after).toBe(Math.min(...dice));
        expect(roll!.discarded_value).toBe(Math.max(...dice));
      } else {
        expect(cond.branch).toBe("none");
        expect(dice).toHaveLength(1);
        expect(player.after).toBe(cond.first_die);
        expect(roll!.discarded_value).toBeNull();
      }

      seenBranches.add(cond.branch);
      await admin.from("rounds").delete().eq("id", roundId);
    }

    // 20 draws of a d20: P(any single branch never appearing) is negligible
    // for the two ~30%/45% bands; require at least two distinct branches so
    // the assertion is robust while still proving the condition actually
    // discriminates.
    expect(seenBranches.size).toBeGreaterThanOrEqual(2);
  });

  it("a conditional-advantage cast leaves an existing plain advantage+disadvantage pair to cancel as before", async () => {
    // The conditional cast contributes advantage only when its first die is
    // 15+, so it never *re-enables* a cancelled pair: a plain Sugar Rush +
    // plain disadvantage on the same player still resolve to one die, and the
    // conditional cast records its own branch alongside.
    const [caster, other] = await Promise.all([
      signUp("gambler-coexist-caster"),
      signUp("gambler-coexist-other"),
    ]);
    const sugarInstance = await forceHold(admin, caster.googleSub, "Sugar Rush");
    const { data: cardRows } = await admin
      .from("spell_cards")
      .select("id, name")
      .in("name", ["Milky Brew", "Gambler's Infusion"]);
    const cardId = Object.fromEntries((cardRows ?? []).map((c) => [c.name, c.id]));
    const { data: freeInstances } = await admin
      .from("spell_deck_instances")
      .select("id, card_id")
      .in("card_id", [cardId["Milky Brew"], cardId["Gambler's Infusion"]]);
    const disInstance = freeInstances!.find((r) => r.card_id === cardId["Milky Brew"])!.id;
    const gamblerInstance = freeInstances!.find(
      (r) => r.card_id === cardId["Gambler's Infusion"],
    )!.id;

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    // Cast Sugar Rush the real way (consumes sugarInstance, makes the 'advantage' cast).
    await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: null });
    void sugarInstance;

    await admin.from("spell_casts").insert([
      {
        round_id: roundId, caster_id: caster.googleSub, card_instance_id: disInstance,
        target_player_id: caster.googleSub, target_pending: false,
        effect_kind: "disadvantage", effect_params: {},
      },
      {
        round_id: roundId, caster_id: caster.googleSub, card_instance_id: gamblerInstance,
        target_player_id: caster.googleSub, target_pending: false,
        effect_kind: "advantage",
        effect_params: { condition: { advantage_at_or_above: 15, disadvantage_at_or_below: 5 } },
      },
    ]);

    await caster.client.rpc("close_round", { p_round_id: roundId });
    await caster.client.rpc("submit_roll", { p_round_id: roundId });

    const { data: roll } = await admin
      .from("rolls").select("value, discarded_value")
      .eq("round_id", roundId).eq("player_id", caster.googleSub).single();
    // Plain advantage + plain disadvantage cancel -> one unmodified die.
    expect(roll!.discarded_value).toBeNull();

    const { data: casts } = await admin
      .from("spell_casts").select("effect_kind, effect_params, cast_inputs")
      .eq("round_id", roundId).in("effect_kind", ["advantage", "disadvantage"]);
    const plain = (casts as { effect_kind: string; effect_params: Record<string, unknown>; cast_inputs: { roll_transform?: Record<string, unknown> } }[])
      .filter((c) => !c.effect_params.condition);
    expect(plain).toHaveLength(2);
    for (const c of plain) {
      const rt = c.cast_inputs.roll_transform!;
      expect(rt.cancelled).toBe(true);
      expect((rt.dice as number[])).toHaveLength(1);
      expect(rt.condition).toBeUndefined();
    }
    // The conditional cast recorded a branch regardless.
    const conditional = (casts as { effect_params: Record<string, unknown>; cast_inputs: { roll_transform?: Record<string, unknown> } }[])
      .find((c) => c.effect_params.condition)!;
    expect((conditional.cast_inputs.roll_transform!.condition as { branch: string }).branch)
      .toMatch(/^(advantage|disadvantage|none)$/);
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
