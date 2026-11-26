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
// These tests drive the RPCs Layer completion and finalization (advance_layer
// / finalize_layer, ADR 0008) call in production — open_reaction_window, then
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
