import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
} from "./setup";

// Runs against a real Supabase stack. Issue #432 (spec #401, design #382):
// Brew IOU -- "Choose a target to make tea this round; you make it next
// round, no roll required."
//
//   * This round: a plain `chosen` tea_maker_override. When it actually names
//     the Tea Maker, the round records ('brew_iou', cast) in
//     rounds.brewer_source / brewer_source_cast_id -- a Brew Debt.
//   * A debt is live while no round has recorded ('brew_debt', cast). The
//     Debtor's next round as a Participant -- any room, any day -- is a debt
//     round: nobody rolls, no Reaction Window, it resolves at close with the
//     Debtor as Tea Maker. An immune Debtor plays normally and still owes.
// Assertions are on observable outcomes: the brewer, rounds.brewer_source,
// modifiers, who is expected to roll, and the Resolution Trace.

const BREW_IOU = "Brew IOU";

describe.skipIf(!hasAnonTestEnv)("Brew IOU (#432)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  // -----------------------------------------------------------------------
  // The card and the Brew IOU round.
  // -----------------------------------------------------------------------

  it("is un-benched, with a `chosen` override row flagged as creating a Brew Debt", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", BREW_IOU)
      .single();
    expect(inst!.location).not.toBe("benched");

    const { data: effects } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params, spell_cards!inner(name)")
      .eq("spell_cards.name", BREW_IOU);
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      target_role: "TARGET",
      effect_kind: "tea_maker_override",
      effect_params: { mode: "chosen", creates_brew_debt: true },
    });
  });
});
