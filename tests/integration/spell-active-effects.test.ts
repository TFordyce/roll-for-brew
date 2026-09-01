import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byTarget,
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises
// spell_active_effects and its RPCs (supabase/migrations/
// 0020_spell_active_effects.sql, issue #69): a persistent modifier-bucket
// effect (Caffeine Crash) composing across its remaining rounds and
// expiring on schedule, and a Detox-style card (Lesser Detox) ending
// another player's active effect early, scoped by tier.
// Row shape returned by get_dispellable_active_effects, shared by the two
// Detox tests below so the byTarget(...) cast isn't typed out twice.
type DispellableEffectRow = {
  effect_id: string;
  target_player_id: string;
  target_display_name: string;
  card_name: string;
  tier: string;
};

describe.skipIf(!hasAnonTestEnv)("spell active effects: persistence, expiry, and Detox", () => {
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

  async function seedRoll(
    roundId: string,
    playerId: string,
    value: number,
    modifierSnapshot: number,
  ) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: modifierSnapshot,
    });
    expect(error).toBeNull();
  }

  /**
   * Seeds a Common-tier, positive-polarity persistent active effect. #312
   * retired `hidden_modifier` and deleted Cloud of Cream's effect row (its
   * surviving mechanic — targeting skip — is Tier A primitive 5, a later
   * ticket), so no castable Common-tier persistent card remains. The tests
   * below only exercise the spell_active_effects reader / dispel RPCs, not a
   * card's cast->record path (covered by the Caffeine Crash test above), so
   * seedActiveEffect stands the row up directly — card_id still points at
   * Cloud of Cream for a stable card_name / tier / polarity, and the source
   * cast it now requires (#310) lands in its own prior resolved round.
   */
  async function seedCommonActiveEffect(roomId: string, playerId: string) {
    const { effectId } = await seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId: playerId,
      casterId: playerId,
      cardName: "Cloud of Cream",
      effectKind: "flat_modifier",
      effectParams: {},
      roundsRemaining: 2,
    });
    return effectId;
  }

  it("Caffeine Crash composes into the modifier bucket for exactly its 2 remaining rounds, then expires", async () => {
    const [caster, target] = await Promise.all([signUp("crash-caster"), signUp("crash-target")]);
    await forceHold(admin, caster.googleSub, "Caffeine Crash");

    // Round 1: cast with an immediate target (target already declared in).
    const { data: round1Id } = await caster.client.rpc("start_round");
    cleanup.trackRound(round1Id as string);
    await target.client.rpc("declare_in", { p_round_id: round1Id });

    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: round1Id,
      p_target_player_id: target.googleSub,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: round1Effects, error: round1EffectsError } = await caster.client.rpc(
      "get_round_modifier_effects",
      { p_round_id: round1Id },
    );
    expect(round1EffectsError).toBeNull();
    // Room-wide RPC (get_round_modifier_effects): filter to this test's own
    // target before asserting exact contents (issue #147).
    expect(byTarget(round1Effects as { target_player_id: string }[], target.googleSub)).toEqual([
      {
        target_player_id: target.googleSub,
        effect_kind: "set_modifier",
        effect_params: { value: -1 },
        resolved_value: null,
        card_name: "Caffeine Crash",
        caster_player_id: caster.googleSub,
      },
    ]);

    const { data: activeAfterCast } = await admin
      .from("spell_active_effects")
      .select("rounds_remaining")
      .eq("source_cast_id", castId);
    expect(activeAfterCast).toEqual([{ rounds_remaining: 2 }]);

    await caster.client.rpc("close_round", { p_round_id: round1Id });
    await seedRoll(round1Id as string, caster.googleSub, 10, 0);
    await seedRoll(round1Id as string, target.googleSub, 15, 0);
    const { error: resolve1Error } = await caster.client.rpc("resolve_round", {
      p_round_id: round1Id,
      p_brewer_id: caster.googleSub,
      p_cups_made: 2,
    });
    expect(resolve1Error).toBeNull();

    // #310: rounds_remaining is an immutable duration snapshot — resolving a
    // round no longer decrements it. The row is still present and still
    // composes (asserted for round 2 below); expiry is derived, proven by
    // its absence from get_round_modifier_effects in round 3.
    const { data: activeAfterRound1 } = await admin
      .from("spell_active_effects")
      .select("rounds_remaining")
      .eq("source_cast_id", castId);
    expect(activeAfterRound1).toEqual([{ rounds_remaining: 2 }]);

    // Round 2: the effect is still active — 1 round left — and still
    // composes into the modifier bucket without any new cast.
    const { data: round2Id } = await caster.client.rpc("start_round");
    cleanup.trackRound(round2Id as string);
    await target.client.rpc("declare_in", { p_round_id: round2Id });

    const { data: round2Effects } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: round2Id,
    });
    expect(byTarget(round2Effects as { target_player_id: string }[], target.googleSub)).toEqual([
      {
        target_player_id: target.googleSub,
        effect_kind: "set_modifier",
        effect_params: { value: -1 },
        resolved_value: null,
        card_name: "Caffeine Crash",
        caster_player_id: caster.googleSub,
      },
    ]);

    await caster.client.rpc("close_round", { p_round_id: round2Id });
    await seedRoll(round2Id as string, caster.googleSub, 8, 0);
    await seedRoll(round2Id as string, target.googleSub, 12, 0);
    await caster.client.rpc("resolve_round", {
      p_round_id: round2Id,
      p_brewer_id: caster.googleSub,
      p_cups_made: 2,
    });

    // #310: the row physically persists (projection, not a mutable counter) —
    // its snapshot is untouched. What changes is that it is now derived-
    // expired: the round 3 check below shows it no longer composes.
    const { data: activeAfterRound2 } = await admin
      .from("spell_active_effects")
      .select("rounds_remaining")
      .eq("source_cast_id", castId);
    expect(activeAfterRound2).toEqual([{ rounds_remaining: 2 }]);

    // Round 3: expired — the modifier bucket no longer sees it.
    const { data: round3Id } = await caster.client.rpc("start_round");
    cleanup.trackRound(round3Id as string);
    await target.client.rpc("declare_in", { p_round_id: round3Id });

    const { data: round3Effects } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: round3Id,
    });
    expect(byTarget(round3Effects as { target_player_id: string }[], target.googleSub)).toEqual([]);
  });

  it("roster badges (get_room_active_effects) show a positive-polarity badge for the caster's own Cloud of Cream", async () => {
    const caster = await signUp("cloud-caster");
    await seedCommonActiveEffect(caster.roomId, caster.googleSub);

    const { data: badges, error: badgesError } = await caster.client.rpc("get_room_active_effects", {
      p_room_id: caster.roomId,
    });
    expect(badgesError).toBeNull();
    // Room-wide RPC (get_room_active_effects): filter to this test's own
    // target before asserting exact contents (issue #147).
    expect(byTarget(badges as { target_player_id: string }[], caster.googleSub)).toEqual([
      {
        effect_id: expect.any(String),
        target_player_id: caster.googleSub,
        card_name: "Cloud of Cream",
        tier: "common",
        polarity: "positive",
        rounds_remaining: 2,
      },
    ]);
  });

  it("Lesser Detox ends a Common-tier active effect early, but is rejected against a Rare one", async () => {
    const [cloudCaster, crashCaster, crashTarget, detoxer] = await Promise.all([
      signUp("detox-cloud-caster"),
      signUp("detox-crash-caster"),
      signUp("detox-crash-target"),
      signUp("detox-detoxer"),
    ]);

    // Independent setup: Caffeine Crash into crashCaster's hand + a Common-tier
    // active effect on cloudCaster (see seedCommonActiveEffect).
    await Promise.all([
      forceHold(admin, crashCaster.googleSub, "Caffeine Crash"),
      seedCommonActiveEffect(cloudCaster.roomId, cloudCaster.googleSub),
    ]);

    const { data: roundId } = await cloudCaster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await crashCaster.client.rpc("declare_in", { p_round_id: roundId });
    await crashTarget.client.rpc("declare_in", { p_round_id: roundId });
    await detoxer.client.rpc("declare_in", { p_round_id: roundId });

    const { error: crashCastError } = await crashCaster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: crashTarget.googleSub,
    });
    expect(crashCastError).toBeNull();

    const { data: rareEffect } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("target_player_id", crashTarget.googleSub)
      .single();

    // Not holding Lesser Detox yet: nothing dispellable.
    const { data: beforeHold } = await detoxer.client.rpc("get_dispellable_active_effects", {
      p_round_id: roundId,
    });
    expect(beforeHold).toEqual([]);

    const detoxInstanceId = await forceHold(admin, detoxer.googleSub, "Lesser Detox");

    const { data: dispellable, error: dispellableError } = await detoxer.client.rpc(
      "get_dispellable_active_effects",
      { p_round_id: roundId },
    );
    expect(dispellableError).toBeNull();
    // Room-wide RPC (get_dispellable_active_effects): filter to this test's
    // own target before asserting exact contents (issue #147).
    const cloudDispellable = byTarget(
      dispellable as DispellableEffectRow[],
      cloudCaster.googleSub,
    );
    expect(cloudDispellable).toEqual([
      {
        effect_id: expect.any(String),
        target_player_id: cloudCaster.googleSub,
        target_display_name: expect.any(String),
        card_name: "Cloud of Cream",
        tier: "common",
      },
    ]);

    // Rejected: Caffeine Crash's active effect is Rare, out of Lesser
    // Detox's Common-only scope.
    const { error: rejectError } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: rareEffect!.id,
    });
    expect(rejectError).not.toBeNull();

    const { data: rareStillThere } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("id", rareEffect!.id);
    expect(rareStillThere).toHaveLength(1);

    // Accepted: Cloud of Cream is Common-tier.
    const cloudEffectId = cloudDispellable[0]!.effect_id;
    const { error: endError } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: cloudEffectId,
    });
    expect(endError).toBeNull();

    // #310: end_active_effect logs a dispel cast instead of deleting the row.
    // The row physically persists...
    const { data: cloudRow } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("id", cloudEffectId);
    expect(cloudRow).toHaveLength(1);
    // ...but the logged dispel drops it from the projection: it is no longer
    // live in the room.
    const { data: liveAfterDispel } = await cloudCaster.client.rpc("get_room_active_effects", {
      p_room_id: cloudCaster.roomId,
    });
    expect(byTarget(liveAfterDispel as { target_player_id: string }[], cloudCaster.googleSub)).toEqual(
      [],
    );

    const { data: detoxInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", detoxInstanceId)
      .single();
    expect(detoxInstance).toEqual({ location: "in_deck", held_by_player: null });
  });

  it("Greater Detox (issue #70) ends a Rare-tier active effect early, but is rejected against a Common one", async () => {
    const [cloudCaster, crashCaster, crashTarget, detoxer] = await Promise.all([
      signUp("greater-detox-cloud-caster"),
      signUp("greater-detox-crash-caster"),
      signUp("greater-detox-crash-target"),
      signUp("greater-detox-detoxer"),
    ]);

    await forceHold(admin, crashCaster.googleSub, "Caffeine Crash");

    const { data: roundId } = await cloudCaster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await crashCaster.client.rpc("declare_in", { p_round_id: roundId });
    await crashTarget.client.rpc("declare_in", { p_round_id: roundId });
    await detoxer.client.rpc("declare_in", { p_round_id: roundId });

    // Common-tier active effect on cloudCaster (see seedCommonActiveEffect).
    await seedCommonActiveEffect(cloudCaster.roomId, cloudCaster.googleSub);

    const { error: crashCastError } = await crashCaster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: crashTarget.googleSub,
    });
    expect(crashCastError).toBeNull();

    const { data: commonEffect } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("target_player_id", cloudCaster.googleSub)
      .single();

    const detoxInstanceId = await forceHold(admin, detoxer.googleSub, "Greater Detox");

    const { data: dispellable, error: dispellableError } = await detoxer.client.rpc(
      "get_dispellable_active_effects",
      { p_round_id: roundId },
    );
    expect(dispellableError).toBeNull();
    // Room-wide RPC (get_dispellable_active_effects): filter to this test's
    // own target before asserting exact contents (issue #147).
    const crashDispellable = byTarget(
      dispellable as DispellableEffectRow[],
      crashTarget.googleSub,
    );
    expect(crashDispellable).toEqual([
      {
        effect_id: expect.any(String),
        target_player_id: crashTarget.googleSub,
        target_display_name: expect.any(String),
        card_name: "Caffeine Crash",
        tier: "rare",
      },
    ]);

    // Rejected: Cloud of Cream's active effect is Common, out of Greater
    // Detox's Rare/Epic-only scope.
    const { error: rejectError } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: commonEffect!.id,
    });
    expect(rejectError).not.toBeNull();

    const { data: commonStillThere } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("id", commonEffect!.id);
    expect(commonStillThere).toHaveLength(1);

    // Accepted: Caffeine Crash is Rare-tier.
    const rareEffectId = crashDispellable[0]!.effect_id;
    const { error: endError } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: rareEffectId,
    });
    expect(endError).toBeNull();

    // #310: the row persists; the logged dispel drops it from the projection.
    const { data: rareRow } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("id", rareEffectId);
    expect(rareRow).toHaveLength(1);
    const { data: liveAfterDispel } = await crashTarget.client.rpc("get_room_active_effects", {
      p_room_id: crashTarget.roomId,
    });
    expect(byTarget(liveAfterDispel as { target_player_id: string }[], crashTarget.googleSub)).toEqual(
      [],
    );

    const { data: detoxInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", detoxInstanceId)
      .single();
    expect(detoxInstance).toEqual({ location: "in_deck", held_by_player: null });
  });

  it("negating the originating cast re-projects a persistent effect away (#310)", async () => {
    const [caster, target] = await Promise.all([signUp("negate-caster"), signUp("negate-target")]);
    await forceHold(admin, caster.googleSub, "Caffeine Crash");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castError).toBeNull();

    // Present while the source cast stands.
    const { data: before } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    expect(byTarget(before as { target_player_id: string }[], target.googleSub)).toHaveLength(1);

    // Negate the source cast — the projection re-derives without it.
    const { error: negErr } = await admin
      .from("spell_casts")
      .update({ negated: true })
      .eq("id", castId);
    expect(negErr).toBeNull();

    const { data: after } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    expect(byTarget(after as { target_player_id: string }[], target.googleSub)).toEqual([]);
  });

  it("rebuild_active_effects_projection reproduces the incremental projection (#310)", async () => {
    const p1 = await signUp("rebuild-p1");

    // A dedicated room: rebuild_active_effects_projection rewrites a whole
    // room's projection, so it must not run against the shared suite room.
    const { data: room, error: roomErr } = await admin
      .from("rooms")
      .insert({ date: null })
      .select("id")
      .single();
    expect(roomErr).toBeNull();
    cleanup.trackRoom(room!.id);
    const { error: rpErr } = await admin
      .from("room_players")
      .insert({ room_id: room!.id, player_id: p1.googleSub });
    expect(rpErr).toBeNull();

    await seedActiveEffect(admin, cleanup, {
      roomId: room!.id,
      targetPlayerId: p1.googleSub,
      casterId: p1.googleSub,
      cardName: "Caffeine Crash",
      effectKind: "set_modifier",
      effectParams: { value: -1 },
      roundsRemaining: 2,
    });
    await seedActiveEffect(admin, cleanup, {
      roomId: room!.id,
      targetPlayerId: p1.googleSub,
      casterId: p1.googleSub,
      cardName: "Jinxed Biscuit",
      effectKind: "ward",
      effectParams: { polarity: ["positive"], domain: ["modifier"] },
      roundsRemaining: 3,
    });

    const cols =
      "target_player_id, caster_id, card_id, effect_kind, effect_params, rounds_remaining, source_cast_id";
    const snapshot = async () =>
      (
        await admin
          .from("spell_active_effects")
          .select(cols)
          .eq("room_id", room!.id)
          .order("source_cast_id")
      ).data;

    const incremental = await snapshot();
    expect(incremental).toHaveLength(2);

    const { error: rebuildErr } = await admin.rpc("rebuild_active_effects_projection", {
      p_room_id: room!.id,
    });
    expect(rebuildErr).toBeNull();

    expect(await snapshot()).toEqual(incremental);
  });
});
