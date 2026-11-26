import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Covers issue #344 — ward interaction
// for the modifier-transfer / round-scoped snapshot cards (migration 0089,
// on top of #342 / #343). A transfer or steal is atomic: when the side that
// LOSES modifier holds a matching active ward the whole effect no-ops that
// resolve (both sides), outcome `blocked`, and the casting card is still
// spent. Detection is at cast time for the four Action cards (Chai-nge of
// Heart / Tea Leaf / Spillage / Bes-Tea) and per tick, inside resolve_round,
// for Bitter Leech. Assertions are on externally observable outcomes only.

describe.skipIf(!hasAnonTestEnv)("ward × modifier-transfer interaction (issue #344)", () => {
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

  type Player = Awaited<ReturnType<typeof signUp>>;

  async function setBaseModifier(actor: Player, target: Player, delta: number) {
    if (delta === 0) return;
    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: delta,
      p_reason: "issue #344 test baseline",
    });
    expect(error).toBeNull();
  }

  async function startRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  /** A ward "carried in from an earlier round" — an unbounded spell_active_effects row. */
  async function seedWard(
    roomId: string,
    casterId: string,
    targetPlayerId: string,
    effectParams: Record<string, unknown>,
    cardName: string,
  ) {
    const { castId } = await seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId,
      casterId,
      cardName,
      effectKind: "ward",
      effectParams,
      roundsRemaining: null,
    });
    return castId;
  }

  // ==========================================================================
  // Chai-nge of Heart
  // ==========================================================================

  // ==========================================================================
  // Tea Leaf / Spillage
  // ==========================================================================

  // ==========================================================================
  // Bes-Tea
  // ==========================================================================

  it.each(["negated", "dispelled"] as const)(
    "Bes-Tea against a %s block_copy ward copies normally (issue #464)",
    async (ended) => {
      const caster = await signUp(`w464-bestea-${ended}-caster`);
      const target = await signUp(`w464-bestea-${ended}-target`);
      await setBaseModifier(target, target, 9);
      const wardCast = await seedWard(
        caster.roomId,
        target.googleSub,
        target.googleSub,
        { polarity: ["positive", "negative"], domain: ["modifier"], block_copy: true },
        "Bag for Life",
      );
      if (ended === "negated") {
        // The ward's source cast was countered.
        const { error } = await admin.from("spell_casts").update({ negated: true }).eq("id", wardCast);
        expect(error).toBeNull();
      } else {
        // A dispel cast in the ward's round names it.
        const { data: ward } = await admin
          .from("spell_active_effects")
          .select("id, spell_casts!inner(round_id)")
          .eq("source_cast_id", wardCast)
          .single();
        const instanceId = await forceHold(admin, caster.googleSub, "Greater Detox");
        await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", instanceId);
        const { error } = await admin.from("spell_casts").insert({
          round_id: (ward!.spell_casts as unknown as { round_id: string }).round_id,
          caster_id: caster.googleSub,
          card_instance_id: instanceId,
          target_player_id: target.googleSub,
          target_pending: false,
          effect_kind: "dispel",
          effect_params: { ended_effect_id: ward!.id },
        });
        expect(error).toBeNull();
      }

      const roundId = await startRound(caster, [target]);
      await forceHold(admin, caster.googleSub, "Bes-Tea");
      await caster.client.rpc("cast_spell_card", { p_round_id: roundId, p_target_player_id: target.googleSub });

      const { data: rows } = await admin
        .from("spell_casts")
        .select("negated, effect_params")
        .eq("round_id", roundId)
        .eq("effect_kind", "set_modifier");
      expect(rows).toEqual([{ negated: false, effect_params: { value: 9 } }]);
    },
  );

  // ==========================================================================
  // Bitter Leech — per-tick
  // ==========================================================================
});
