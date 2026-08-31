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
import { getRoundModifierEffectDetails, getRoundModifierEffects } from "@/lib/supabase/spellCasts";

// Runs against a real, dedicated test Supabase project. Exercises
// 0050_round_modifier_effects_card_and_advantage.sql (issue #165): the
// get_round_modifier_effects RPC now also returns card_name/caster_player_id
// per effect, and includes advantage/disadvantage rows it used to exclude —
// so the UI (issue #167) can label a round's modifiers by which card, cast
// by whom, produced them.
describe.skipIf(!hasAnonTestEnv)("round modifier effects: card name, caster, advantage/disadvantage (issue #165)", () => {
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

  it("labels a flat-modifier effect with its card name and caster", async () => {
    const caster = await signUp("card-data-flat-caster");
    await forceHold(admin, caster.googleSub, "Lucky Sip");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    const { data: effects, error: effectsError } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    expect(effectsError).toBeNull();

    // Room-wide RPC: filter to this test's own target (issue #147).
    const rows = byTarget(
      effects as {
        target_player_id: string;
        effect_kind: string;
        effect_params: Record<string, unknown>;
        resolved_value: number | null;
        card_name: string;
        caster_player_id: string;
      }[],
      caster.googleSub,
    );
    expect(rows).toEqual([
      {
        target_player_id: caster.googleSub,
        effect_kind: "flat_modifier",
        effect_params: { delta: 3 },
        resolved_value: null,
        card_name: "Lucky Sip",
        caster_player_id: caster.googleSub,
      },
    ]);
  });

  it("includes disadvantage rows (previously excluded) labelled with card name and caster", async () => {
    const [caster, target] = await Promise.all([
      signUp("card-data-disadv-caster"),
      signUp("card-data-disadv-target"),
    ]);
    await forceHold(admin, caster.googleSub, "Slipped Spoon");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castError).toBeNull();

    const details = await getRoundModifierEffectDetails(caster.client, roundId as string);
    const targetDetail = details.find(
      (d) => d.targetPlayerId === target.googleSub && d.effectKind === "disadvantage",
    );
    expect(targetDetail).toEqual({
      targetPlayerId: target.googleSub,
      effectKind: "disadvantage",
      effectParams: {},
      resolvedValue: null,
      cardName: "Slipped Spoon",
      casterPlayerId: caster.googleSub,
    });

    // getRoundModifierEffects (the pre-existing modifier-composition entry
    // point) must stay unaffected by the RPC now including advantage/
    // disadvantage rows — it should still drop them, not compose them into
    // a modifier.
    const byPlayer = await getRoundModifierEffects(caster.client, roundId as string);
    expect(byPlayer.get(target.googleSub) ?? []).toEqual([]);
  });
});
