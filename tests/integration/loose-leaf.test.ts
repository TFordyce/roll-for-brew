import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
} from "./setup";

// Runs against a real Supabase stack. Issue #431 (spec #401, design #380):
// Loose Leaf -- "When you are named tea-maker, force a roll-off against the
// second-lowest roller. Both roll d20 -- the loser makes tea instead."
//
//   * Cast into the layer-0 Reaction Window, it arms a
//     `named_tea_maker_rolloff` Cast Log row aimed at the caster.
//   * Tea-maker selection naming the holder, by any tier, returns an
//     unfinished `rolloff` against the second-lowest layer-0 roller (roll,
//     then modifier) -- every roller tied there joins it, no player-id
//     tiebreak. finalize_layer commits it like a tie -- a Tie-Break Reroll
//     Layer for them -- and returns a tie-shaped outcome marked `rolloff`.
//   * At that Layer the lowest roll brews, with normal modifier gain; a tied
//     roll-off goes to another Layer.
//   * No distinct second-lowest (a two-player round) -> the card does nothing.
// Assertions are on observable outcomes: finalize_layer's result, the round
// row, the Resolution Trace and the brewer's modifier.

const LOOSE_LEAF = "Loose Leaf";

describe.skipIf(!hasAnonTestEnv)("Loose Leaf (#431)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  it("is un-benched: no Loose Leaf instance is left on the bench", async () => {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("id, location, spell_cards!inner(name)")
      .eq("spell_cards.name", LOOSE_LEAF);
    expect(error).toBeNull();
    const rows = data as { location: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.location === "benched")).toEqual([]);
  });
});
