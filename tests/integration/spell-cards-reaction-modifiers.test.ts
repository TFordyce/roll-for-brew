import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byTarget,
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises two of
// issue #70's newly-mapped Reaction cards through the reaction window
// (supabase/migrations/0021_spell_reaction_window.sql, issue #68): Six
// Sugars (dice_modifier, SELF) and Mug Shot (set_modifier, OPPONENT), both
// proving that a numeric-kind Reaction cast composes into
// get_round_modifier_effects the same way a pre-roll Action cast already
// does (the modifier bucket doesn't distinguish how a cast was made).
//
// Six Sugars' dice_modifier casts with no cast_inputs.dice_roll until the
// caster resolves it (issue #252, migration 0069) — resolved here via
// resolve_pending_spell_die_in_app immediately after casting, same as the
// compound-card tests (spell-cards-compound.test.ts).
describe.skipIf(!hasAnonTestEnv)("spell cards: reaction-timed numeric modifiers (issue #70)", () => {
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

  it("Six Sugars (dice_modifier, Reaction/Self) resolves 1d6 through the reaction window", async () => {
    const [caster, other] = await Promise.all([
      signUp("six-sugars-caster"),
      signUp("six-sugars-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Six Sugars");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    const { data: openData, error: openError } = await caster.client.rpc("open_reaction_window", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(openError).toBeNull();
    expect((openData as { is_closed: boolean }[])[0]!.is_closed).toBe(false);

    const { data: castId, error: castError } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: pending } = await caster.client.rpc("get_my_pending_spell_dice", { p_round_id: roundId });
    const pendingCastId = (pending as { cast_id: string }[])[0]!.cast_id;

    // Issue #306: the unrolled sentinel is the ABSENCE of cast_inputs.dice_roll,
    // not resolved_value IS NULL.
    const { data: preRow } = await admin
      .from("spell_casts")
      .select("cast_inputs")
      .eq("id", pendingCastId)
      .single();
    expect(preRow!.cast_inputs ?? {}).not.toHaveProperty("dice_roll");

    const { error: resolveError } = await caster.client.rpc("resolve_pending_spell_die_in_app", {
      p_cast_id: pendingCastId,
    });
    expect(resolveError).toBeNull();

    // #312: resolution writes cast_inputs.dice_roll (raw, unsigned) — the sole
    // source of truth now that resolved_value is dropped.
    const { data: postRow } = await admin
      .from("spell_casts")
      .select("cast_inputs")
      .eq("id", pendingCastId)
      .single();
    const diceRoll = (postRow!.cast_inputs as { dice_roll: number }).dice_roll;
    expect(diceRoll).toBeGreaterThanOrEqual(1);
    expect(diceRoll).toBeLessThanOrEqual(6);

    const { data: effects, error: effectsError } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    expect(effectsError).toBeNull();
    // Room-wide RPC (get_round_modifier_effects): filter to this test's own
    // target before asserting exact contents (issue #147).
    const casterEffects = byTarget(
      effects as { target_player_id: string; resolved_value: number }[],
      caster.googleSub,
    );
    expect(casterEffects).toEqual([
      {
        target_player_id: caster.googleSub,
        effect_kind: "dice_modifier",
        effect_params: { dice: "1d6" },
        resolved_value: expect.any(Number),
        card_name: "Six Sugars",
        caster_player_id: caster.googleSub,
      },
    ]);
    const resolvedValue = casterEffects[0]!.resolved_value;
    expect(resolvedValue).toBeGreaterThanOrEqual(1);
    expect(resolvedValue).toBeLessThanOrEqual(6);
  });

  it("Mug Shot (set_modifier, Reaction/Opponent) negates a target's modifier through the reaction window", async () => {
    const [caster, target] = await Promise.all([
      signUp("mug-shot-caster"),
      signUp("mug-shot-target"),
    ]);
    await forceHold(admin, caster.googleSub, "Mug Shot");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    const { error: openError } = await caster.client.rpc("open_reaction_window", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(openError).toBeNull();

    const { data: castId, error: castError } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: effects, error: effectsError } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    expect(effectsError).toBeNull();
    // Room-wide RPC (get_round_modifier_effects): filter to this test's own
    // target before asserting exact contents (issue #147).
    expect(byTarget(effects as { target_player_id: string }[], target.googleSub)).toEqual([
      {
        target_player_id: target.googleSub,
        effect_kind: "set_modifier",
        effect_params: { value: 0 },
        resolved_value: null,
        card_name: "Mug Shot",
        caster_player_id: caster.googleSub,
      },
    ]);
  });
});
