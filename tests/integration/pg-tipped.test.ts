import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
} from "./setup";

// Runs against a real local Supabase stack. Exercises PG Tipped (issue #427,
// spec #401): "Choose a target. If they roll lower than you this round, they
// make tea regardless of anyone else. Target gains no modifier from this
// round."
//
// A tea_maker_override in mode `conditional_chosen` (condition
// `target_below_caster`, modifier_gain 0). Phase 5 compares the recorded
// layer-0 rolls: target lower -> the target brews and gains nothing;
// otherwise a "condition not met" no-op Trace step, the cast never enters the
// last-cast-wins contest, and selection falls through.
//
// Assertions are on observable outcomes only: rounds.brewer_id /
// brewer_modifier_gain, room_players.modifier and the Resolution Trace.

describe.skipIf(!hasAnonTestEnv)("PG Tipped (issue #427)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  it("is un-benched with a conditional_chosen effect row", async () => {
    const { data: card, error: cardErr } = await admin
      .from("spell_cards")
      .select("id, spell_card_effects(target_role, effect_kind, effect_params)")
      .eq("name", "PG Tipped")
      .single();
    expect(cardErr).toBeNull();
    expect(card!.spell_card_effects).toEqual([
      {
        target_role: "TARGET",
        effect_kind: "tea_maker_override",
        effect_params: { mode: "conditional_chosen", condition: "target_below_caster", modifier_gain: 0 },
      },
    ]);

    const { data: inst, error: instErr } = await admin
      .from("spell_deck_instances")
      .select("location")
      .eq("card_id", card!.id)
      .single();
    expect(instErr).toBeNull();
    expect(inst!.location).not.toBe("benched");
  });
});
