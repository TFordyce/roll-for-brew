import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
} from "./setup";

// Runs against a real Supabase stack. Issue #433 (spec #401 F5, design #393):
// Roll Exemption, with Loaf of Lipton as its first user -- "Skip your roll
// this round and make tea automatically. You gain double the usual modifier."
//
//   * The card's catalog row carries `exempt_from_rolling: true`. Its caster
//     has no layer-0 roll: get_expected_layer_roller_ids leaves them out, so
//     the roll gate, Layer completeness and stall all follow.
//   * Loaf itself is a `chosen` self-override whose gain is 2 * cups_made.
//   * Countered: once the layer-0 Reaction Window has CLOSED with the cast
//     negated, the caster is an expected roller again and rolls late.
//   * Every participant exempt: the round resolves at close.
//   * The exemption covers layer 0 only, and a replay's clean slate wipes it.
// Assertions are on observable outcomes: who is expected to roll, the
// brewer and gain, modifiers, and the Resolution Trace.

const LOAF = "Loaf of Lipton";

describe.skipIf(!hasAnonTestEnv)("Roll Exemption + Loaf of Lipton (#433)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  // -----------------------------------------------------------------------
  // The card.
  // -----------------------------------------------------------------------

  it("is un-benched, with one `chosen` self-override row: double gain, exempt from rolling", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", LOAF)
      .single();
    expect(inst!.location).not.toBe("benched");

    const { data: effects } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params, spell_cards!inner(name)")
      .eq("spell_cards.name", LOAF);
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      target_role: "CASTER",
      effect_kind: "tea_maker_override",
      effect_params: { mode: "chosen", modifier_gain_multiplier: 2, exempt_from_rolling: true },
    });
  });
});
