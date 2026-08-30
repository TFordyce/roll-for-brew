import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Covers issue #286:
// Yorkshire Terror (Common, OPPONENT, Action) — "Choose a target. After they
// roll, they must reroll and keep the new result." — used to have no
// spell_card_effects row and was silently burned on cast. 0075 adds the
// forced_reroll / TARGET row and restores the layer-0 window-attach that
// 0064 dropped from open_reaction_window, so the pre-roll -> apply path a
// TARGET forced_reroll cast rides works end to end again.
//
// These tests drive the RPCs finalizeReactionWindow (src/app/rounds/
// layerResolution.ts) would call in production — open_reaction_window, then
// get_forced_reroll_targets / apply_forced_reroll — directly.
describe.skipIf(!hasAnonTestEnv)("Yorkshire Terror: forced_reroll effect row (issue #286)", () => {
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

  it("has exactly one forced_reroll / TARGET effect row", async () => {
    const { data: card } = await admin
      .from("spell_cards")
      .select("id")
      .eq("name", "Yorkshire Terror")
      .single();

    const { data: effects, error } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params")
      .eq("card_id", card!.id);
    expect(error).toBeNull();
    expect(effects).toEqual([
      { target_role: "TARGET", effect_kind: "forced_reroll", effect_params: {} },
    ]);
  });

  it("its deck instance is drawable (location = 'in_deck', unheld)", async () => {
    const { data: card } = await admin
      .from("spell_cards")
      .select("id")
      .eq("name", "Yorkshire Terror")
      .single();

    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("card_id", card!.id)
      .single();
    expect(instance).toEqual({ location: "in_deck", held_by_player: null });
  });

  it("cast pre-roll at a declared-in target rerolls that target's roll in place", async () => {
    const caster = await signUp("yorkshire-caster");
    const target = await signUp("yorkshire-target");
    await forceHold(admin, caster.googleSub, "Yorkshire Terror");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: castRows } = await admin
      .from("spell_casts")
      .select("effect_kind, target_player_id, target_pending, negated, reaction_window_id")
      .eq("round_id", roundId);
    expect(castRows).toHaveLength(1);
    expect(castRows![0]).toMatchObject({
      effect_kind: "forced_reroll",
      target_player_id: target.googleSub,
      target_pending: false,
      negated: false,
      reaction_window_id: null,
    });

    await caster.client.rpc("close_round", { p_round_id: roundId });

    await admin.from("rolls").insert([
      { round_id: roundId, player_id: caster.googleSub, layer: 0, value: 11, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: target.googleSub, layer: 0, value: 3, input_mode: "manual", modifier_snapshot: 0 },
    ]);

    const { error: openError } = await admin.rpc("open_reaction_window", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(openError).toBeNull();

    const { data: targets, error: targetsError } = await caster.client.rpc("get_forced_reroll_targets", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(targetsError).toBeNull();
    expect((targets as { target_player_id: string }[]).map((r) => r.target_player_id)).toEqual([
      target.googleSub,
    ]);

    const { data: newValue, error: applyError } = await caster.client.rpc("apply_forced_reroll", {
      p_round_id: roundId,
      p_layer: 0,
      p_player_id: target.googleSub,
    });
    expect(applyError).toBeNull();
    expect(newValue).toBeGreaterThanOrEqual(1);
    expect(newValue).toBeLessThanOrEqual(20);

    const { data: rollRow } = await admin
      .from("rolls")
      .select("value")
      .eq("round_id", roundId)
      .eq("player_id", target.googleSub)
      .eq("layer", 0)
      .single();
    expect(rollRow!.value).toBe(newValue);
  });

  it("deferred target set after the window opens is still attached (via set_spell_cast_target)", async () => {
    const caster = await signUp("yorkshire-deferred-caster");
    const target = await signUp("yorkshire-deferred-target");
    // A held Reaction card keeps the window open past open_reaction_window so
    // set_spell_cast_target still has an open window to attach to — the only
    // ordering where its late-attach matters. The deferred + no-eligible-
    // reactor path (window closes and the layer finalizes in the same request,
    // before set_spell_cast_target can run) is the KNOWN GAP documented in
    // migration 0075's header and left to a follow-up.
    const reactor = await signUp("yorkshire-deferred-reactor");
    await forceHold(admin, caster.googleSub, "Yorkshire Terror");
    await forceHold(admin, reactor.googleSub, "Milk First?");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    await reactor.client.rpc("declare_in", { p_round_id: roundId });

    // Cast with no target — defers (target_pending = true).
    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    await caster.client.rpc("close_round", { p_round_id: roundId });

    await admin.from("rolls").insert([
      { round_id: roundId, player_id: caster.googleSub, layer: 0, value: 9, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: target.googleSub, layer: 0, value: 2, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: reactor.googleSub, layer: 0, value: 14, input_mode: "manual", modifier_snapshot: 0 },
    ]);

    // Window opens while the cast is still target_pending — not attached yet.
    const { data: openData } = await admin.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });
    expect((openData as { is_closed: boolean }[])[0]!.is_closed).toBe(false);

    const { data: beforeTargets } = await caster.client.rpc("get_forced_reroll_targets", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(beforeTargets).toEqual([]);

    // Caster names the target late — set_spell_cast_target attaches it.
    const { error: setError } = await caster.client.rpc("set_spell_cast_target", {
      p_cast_id: castId,
      p_target_player_id: target.googleSub,
    });
    expect(setError).toBeNull();

    const { data: afterTargets, error: afterError } = await caster.client.rpc("get_forced_reroll_targets", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(afterError).toBeNull();
    expect((afterTargets as { target_player_id: string }[]).map((r) => r.target_player_id)).toEqual([
      target.googleSub,
    ]);
  });

  it("rejects casting Yorkshire Terror on yourself", async () => {
    const caster = await signUp("yorkshire-self-caster");
    const other = await signUp("yorkshire-self-other");
    await forceHold(admin, caster.googleSub, "Yorkshire Terror");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    const { error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: caster.googleSub,
    });
    expect(error?.message).toContain("cannot target yourself");

    // The card must not have been consumed by the rejected cast.
    const { data: held } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("held_by_player", caster.googleSub)
      .maybeSingle();
    expect(held).toMatchObject({ location: "held", held_by_player: caster.googleSub });
  });
});
