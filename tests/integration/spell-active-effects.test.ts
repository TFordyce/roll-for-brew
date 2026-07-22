import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises
// spell_active_effects and its RPCs (supabase/migrations/
// 0020_spell_active_effects.sql, issue #69): a persistent modifier-bucket
// effect (Caffeine Crash) composing across its remaining rounds and
// expiring on schedule, and a Detox-style card (Lesser Detox) ending
// another player's active effect early, scoped by tier.
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

  async function forceHold(playerId: string, cardName: string): Promise<string> {
    const { data: card, error: cardError } = await admin
      .from("spell_cards")
      .select("id")
      .eq("name", cardName)
      .single();
    if (cardError) throw cardError;

    const { data: instance, error: instanceError } = await admin
      .from("spell_deck_instances")
      .select("id")
      .eq("card_id", card.id)
      .single();
    if (instanceError) throw instanceError;

    const { error: updateError } = await admin
      .from("spell_deck_instances")
      .update({ location: "held", held_by_player: playerId })
      .eq("id", instance.id);
    if (updateError) throw updateError;

    return instance.id as string;
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

  it("Caffeine Crash composes into the modifier bucket for exactly its 2 remaining rounds, then expires", async () => {
    const caster = await signUp("crash-caster");
    const target = await signUp("crash-target");
    await forceHold(caster.googleSub, "Caffeine Crash");

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
    expect(round1Effects).toEqual([
      {
        target_player_id: target.googleSub,
        effect_kind: "set_modifier",
        effect_params: { value: -1 },
        resolved_value: null,
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

    const { data: activeAfterRound1 } = await admin
      .from("spell_active_effects")
      .select("rounds_remaining")
      .eq("source_cast_id", castId);
    expect(activeAfterRound1).toEqual([{ rounds_remaining: 1 }]);

    // Round 2: the effect is still active — 1 round left — and still
    // composes into the modifier bucket without any new cast.
    const { data: round2Id } = await caster.client.rpc("start_round");
    cleanup.trackRound(round2Id as string);
    await target.client.rpc("declare_in", { p_round_id: round2Id });

    const { data: round2Effects } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: round2Id,
    });
    expect(round2Effects).toEqual([
      {
        target_player_id: target.googleSub,
        effect_kind: "set_modifier",
        effect_params: { value: -1 },
        resolved_value: null,
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

    const { data: activeAfterRound2 } = await admin
      .from("spell_active_effects")
      .select("rounds_remaining")
      .eq("source_cast_id", castId);
    expect(activeAfterRound2).toEqual([]);

    // Round 3: expired — the modifier bucket no longer sees it.
    const { data: round3Id } = await caster.client.rpc("start_round");
    cleanup.trackRound(round3Id as string);
    await target.client.rpc("declare_in", { p_round_id: round3Id });

    const { data: round3Effects } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: round3Id,
    });
    expect(round3Effects).toEqual([]);
  });

  it("roster badges (get_room_active_effects) show a positive-polarity badge for the caster's own Cloud of Cream", async () => {
    const caster = await signUp("cloud-caster");
    await forceHold(caster.googleSub, "Cloud of Cream");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: caster.googleSub,
    });
    expect(castError).toBeNull();

    const { data: badges, error: badgesError } = await caster.client.rpc("get_room_active_effects", {
      p_room_id: caster.roomId,
    });
    expect(badgesError).toBeNull();
    expect(badges).toEqual([
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
    const cloudCaster = await signUp("detox-cloud-caster");
    const crashCaster = await signUp("detox-crash-caster");
    const crashTarget = await signUp("detox-crash-target");
    const detoxer = await signUp("detox-detoxer");

    await forceHold(cloudCaster.googleSub, "Cloud of Cream");
    await forceHold(crashCaster.googleSub, "Caffeine Crash");

    const { data: roundId } = await cloudCaster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await crashCaster.client.rpc("declare_in", { p_round_id: roundId });
    await crashTarget.client.rpc("declare_in", { p_round_id: roundId });
    await detoxer.client.rpc("declare_in", { p_round_id: roundId });

    const { error: cloudCastError } = await cloudCaster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: cloudCaster.googleSub,
    });
    expect(cloudCastError).toBeNull();

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

    const detoxInstanceId = await forceHold(detoxer.googleSub, "Lesser Detox");

    const { data: dispellable, error: dispellableError } = await detoxer.client.rpc(
      "get_dispellable_active_effects",
      { p_round_id: roundId },
    );
    expect(dispellableError).toBeNull();
    expect(dispellable).toEqual([
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
    const cloudEffectId = (dispellable as { effect_id: string }[])[0]!.effect_id;
    const { error: endError } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: cloudEffectId,
    });
    expect(endError).toBeNull();

    const { data: cloudGone } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("id", cloudEffectId);
    expect(cloudGone).toEqual([]);

    const { data: detoxInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", detoxInstanceId)
      .single();
    expect(detoxInstance).toEqual({ location: "in_deck", held_by_player: null });
  });

  it("Greater Detox (issue #70) ends a Rare-tier active effect early, but is rejected against a Common one", async () => {
    const cloudCaster = await signUp("greater-detox-cloud-caster");
    const crashCaster = await signUp("greater-detox-crash-caster");
    const crashTarget = await signUp("greater-detox-crash-target");
    const detoxer = await signUp("greater-detox-detoxer");

    await forceHold(cloudCaster.googleSub, "Cloud of Cream");
    await forceHold(crashCaster.googleSub, "Caffeine Crash");

    const { data: roundId } = await cloudCaster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await crashCaster.client.rpc("declare_in", { p_round_id: roundId });
    await crashTarget.client.rpc("declare_in", { p_round_id: roundId });
    await detoxer.client.rpc("declare_in", { p_round_id: roundId });

    const { error: cloudCastError } = await cloudCaster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: cloudCaster.googleSub,
    });
    expect(cloudCastError).toBeNull();

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

    const detoxInstanceId = await forceHold(detoxer.googleSub, "Greater Detox");

    const { data: dispellable, error: dispellableError } = await detoxer.client.rpc(
      "get_dispellable_active_effects",
      { p_round_id: roundId },
    );
    expect(dispellableError).toBeNull();
    expect(dispellable).toEqual([
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
    const rareEffectId = (dispellable as { effect_id: string }[])[0]!.effect_id;
    const { error: endError } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: rareEffectId,
    });
    expect(endError).toBeNull();

    const { data: rareGone } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("id", rareEffectId);
    expect(rareGone).toEqual([]);

    const { data: detoxInstance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", detoxInstanceId)
      .single();
    expect(detoxInstance).toEqual({ location: "in_deck", held_by_player: null });
  });
});
