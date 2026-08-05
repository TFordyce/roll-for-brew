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

// Runs against a real, dedicated test Supabase project. Exercises the
// compound-card fix (supabase/migrations/0032_spell_card_effects.sql):
// casting Cold Tea or Slipped Spoon on an opponent used to silently drop
// half the card's effect (only one effect_kind/effect_params pair per card
// could be stored), so the target saw nothing on their roll calculation.
// spell_card_effects now lets a card carry more than one simultaneous
// effect, each with its own target role — these tests confirm both halves
// of a compound cast now compose into get_round_modifier_effects.
describe.skipIf(!hasAnonTestEnv)("spell cards: compound cards (Cold Tea, Slipped Spoon)", () => {
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

  it("Cold Tea applies both the opponent's -3 penalty and the caster's 1d4 bonus", async () => {
    const caster = await signUp("cold-tea-caster");
    const target = await signUp("cold-tea-target");
    await forceHold(admin, caster.googleSub, "Cold Tea");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: effects, error: effectsError } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    expect(effectsError).toBeNull();

    // Room-wide RPC (get_round_modifier_effects): filter to this test's own
    // targets before asserting exact length (issue #147).
    const rows = byTarget(
      effects as {
        target_player_id: string;
        effect_kind: string;
        effect_params: Record<string, unknown>;
        resolved_value: number | null;
      }[],
      caster.googleSub,
      target.googleSub,
    );
    expect(rows).toHaveLength(2);

    const targetRow = rows.find((r) => r.target_player_id === target.googleSub);
    expect(targetRow).toEqual({
      target_player_id: target.googleSub,
      effect_kind: "flat_modifier",
      effect_params: { delta: -3 },
      resolved_value: null,
    });

    const casterRow = rows.find((r) => r.target_player_id === caster.googleSub);
    expect(casterRow).toMatchObject({
      target_player_id: caster.googleSub,
      effect_kind: "dice_modifier",
      effect_params: { dice: "1d4" },
    });
    expect(casterRow!.resolved_value).toBeGreaterThanOrEqual(1);
    expect(casterRow!.resolved_value).toBeLessThanOrEqual(4);
  });

  it("Slipped Spoon applies both the opponent's disadvantage and the caster's 1d4 bonus", async () => {
    const caster = await signUp("slipped-spoon-caster");
    const target = await signUp("slipped-spoon-target");
    await forceHold(admin, caster.googleSub, "Slipped Spoon");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: casts, error: castsError } = await admin
      .from("spell_casts")
      .select("target_player_id, effect_kind, effect_params, resolved_value")
      .eq("round_id", roundId);
    expect(castsError).toBeNull();

    const rows = casts as {
      target_player_id: string;
      effect_kind: string;
      effect_params: Record<string, unknown>;
      resolved_value: number | null;
    }[];
    expect(rows).toHaveLength(2);

    const targetRow = rows.find((r) => r.target_player_id === target.googleSub);
    expect(targetRow).toEqual({
      target_player_id: target.googleSub,
      effect_kind: "disadvantage",
      effect_params: {},
      resolved_value: null,
    });

    const casterRow = rows.find((r) => r.target_player_id === caster.googleSub);
    expect(casterRow).toMatchObject({
      target_player_id: caster.googleSub,
      effect_kind: "dice_modifier",
      effect_params: { dice: "1d4" },
    });
    expect(casterRow!.resolved_value).toBeGreaterThanOrEqual(1);
    expect(casterRow!.resolved_value).toBeLessThanOrEqual(4);
  });
});
