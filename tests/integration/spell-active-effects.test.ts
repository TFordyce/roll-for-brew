import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byTarget,
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  roundModifierEffects,
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
    const { data: before } = await roundModifierEffects(admin, caster.client, roundId);
    expect(byTarget(before as { target_player_id: string }[], target.googleSub)).toHaveLength(1);

    // Negate the source cast — the projection re-derives without it.
    const { error: negErr } = await admin
      .from("spell_casts")
      .update({ negated: true })
      .eq("id", castId);
    expect(negErr).toBeNull();

    const { data: after } = await roundModifierEffects(admin, caster.client, roundId);
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
