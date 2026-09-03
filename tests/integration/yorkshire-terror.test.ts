import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enforceStallTimeout } from "../../src/app/rounds/stallEnforcement";
import { afterDeferredCastTargetSet } from "../../src/app/rounds/roundActionHelpers";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
  stallTimeoutFuture as future,
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
    const [caster, target] = await Promise.all([
      signUp("yorkshire-caster"),
      signUp("yorkshire-target"),
    ]);
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
    const [caster, target] = await Promise.all([
      signUp("yorkshire-deferred-caster"),
      signUp("yorkshire-deferred-target"),
    ]);
    // A held Reaction card keeps the window open past open_reaction_window so
    // set_spell_cast_target still has an open window to attach to — the only
    // ordering where its late-attach matters. The deferred + no-eligible-
    // reactor path (window closes and the layer finalizes in the same request,
    // before set_spell_cast_target can run) was the KNOWN GAP documented in
    // migration 0075's header; issue #325 / migration 0098 closes it, covered
    // by "deferred target, no reactor: layer 0 holds …" below.
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

  it("deferred target, no reactor: layer 0 holds until set_spell_cast_target, then the reroll lands (issue #325)", async () => {
    const [caster, target, third] = await Promise.all([
      signUp("yt-325-caster"),
      signUp("yt-325-target"),
      signUp("yt-325-third"),
    ]);
    // No one holds a Reaction card — the path where open_reaction_window
    // closes the window on the spot and the layer used to finalize before
    // set_spell_cast_target could run.
    await forceHold(admin, caster.googleSub, "Yorkshire Terror");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    await third.client.rpc("declare_in", { p_round_id: roundId });

    // Cast with no target — defers (target_pending = true).
    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    await caster.client.rpc("close_round", { p_round_id: roundId });

    await admin.from("rolls").insert([
      { round_id: roundId, player_id: caster.googleSub, layer: 0, value: 12, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: target.googleSub, layer: 0, value: 4, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: third.googleSub, layer: 0, value: 8, input_mode: "manual", modifier_snapshot: 0 },
    ]);

    // The gate holds: every roll is in, but layer 0 isn't "complete" while
    // the forced_reroll cast is still target_pending.
    const { data: blocked, error: blockedError } = await caster.client.rpc(
      "get_current_layer_rolls_if_complete",
      { p_round_id: roundId },
    );
    expect(blockedError).toBeNull();
    expect(blocked).toEqual([]);

    // The round has not resolved.
    const { data: heldRound } = await admin
      .from("rounds")
      .select("status")
      .eq("id", roundId)
      .single();
    expect(heldRound!.status).toBe("closed");

    // The caster names the target after the layer would otherwise have
    // finalised — no RFB03.
    const { error: setError } = await caster.client.rpc("set_spell_cast_target", {
      p_cast_id: castId,
      p_target_player_id: target.googleSub,
    });
    expect(setError).toBeNull();

    // Gate released — the three rolls are now visible.
    const { data: unblocked } = await caster.client.rpc("get_current_layer_rolls_if_complete", {
      p_round_id: roundId,
    });
    expect((unblocked as { player_id: string }[]).length).toBe(3);

    // Drive the exact app glue setSpellCastTargetAction now runs after
    // set_spell_cast_target: no window exists yet (resolveCompletedLayerIfAny
    // bailed at the gate on the completing roll), so it opens one, which
    // self-closes with no eligible reactor and finalises — attaching the
    // no-longer-pending forced_reroll cast and resolving the round.
    await afterDeferredCastTargetSet(caster.client, roundId as string);

    const { data: resolvedRound } = await admin
      .from("rounds")
      .select("status, resolution_trace")
      .eq("id", roundId)
      .single();
    expect(resolvedRound!.status).toBe("resolved");

    // The target's layer-0 roll was actually rerolled in place...
    const { data: targetRoll } = await admin
      .from("rolls")
      .select("value")
      .eq("round_id", roundId)
      .eq("player_id", target.googleSub)
      .eq("layer", 0)
      .single();
    expect(targetRoll!.value).not.toBe(4);
    expect(targetRoll!.value).toBeGreaterThanOrEqual(1);
    expect(targetRoll!.value).toBeLessThanOrEqual(20);

    // ...and it shows in the persisted Resolution Trace as one forced_reroll
    // step with typed before -> after roll values.
    const rerollSteps = (
      (resolvedRound!.resolution_trace ?? []) as {
        display_kind: string;
        target_player: string | null;
        before: { type: string; value: number };
        after: { type: string; value: number };
      }[]
    ).filter((s) => s.display_kind === "forced_reroll");
    expect(rerollSteps).toHaveLength(1);
    expect(rerollSteps[0]!.target_player).toBe(target.googleSub);
    expect(rerollSteps[0]!.before).toEqual({ type: "roll", value: 4 });
    expect(rerollSteps[0]!.after).toEqual({ type: "roll", value: targetRoll!.value });
  });

  it("never-resolvable deferred target is force-negated by the stall timer as a recorded no-op (issue #325)", async () => {
    const [caster, target, third] = await Promise.all([
      signUp("yt-325-stall-caster"),
      signUp("yt-325-stall-target"),
      signUp("yt-325-stall-third"),
    ]);
    await forceHold(admin, caster.googleSub, "Yorkshire Terror");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    await third.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });

    await caster.client.rpc("close_round", { p_round_id: roundId });

    await admin.from("rolls").insert([
      { round_id: roundId, player_id: caster.googleSub, layer: 0, value: 3, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: target.googleSub, layer: 0, value: 15, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: third.googleSub, layer: 0, value: 9, input_mode: "manual", modifier_snapshot: 0 },
    ]);

    // The caster never names a target. Once the 5-minute closed-round stall
    // timer fires, enforceStallTimeout force-negates the outstanding cast and
    // lets the round resolve off the un-rerolled rolls.
    const outcome = await enforceStallTimeout(caster.client, roundId as string, future);
    expect(outcome).toEqual({ action: "deferredForcedRerollAbandoned" });

    const { data: castRow } = await admin
      .from("spell_casts")
      .select("negated, target_pending, cast_inputs")
      .eq("id", castId)
      .single();
    expect(castRow).toMatchObject({ negated: true, target_pending: false });
    expect((castRow!.cast_inputs as { deferred_target_abandoned?: boolean }).deferred_target_abandoned).toBe(true);

    const { data: round } = await admin
      .from("rounds")
      .select("status, brewer_id")
      .eq("id", roundId)
      .single();
    // caster rolled lowest (3) and no reroll was applied, so caster brews.
    expect(round).toMatchObject({ status: "resolved", brewer_id: caster.googleSub });

    const { data: targetRoll } = await admin
      .from("rolls")
      .select("value")
      .eq("round_id", roundId)
      .eq("player_id", target.googleSub)
      .eq("layer", 0)
      .single();
    expect(targetRoll!.value).toBe(15);
  });

  it("rejects casting Yorkshire Terror on yourself", async () => {
    const [caster, other] = await Promise.all([
      signUp("yorkshire-self-caster"),
      signUp("yorkshire-self-other"),
    ]);
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
