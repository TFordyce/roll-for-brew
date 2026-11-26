import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
} from "./setup";

// Runs against a real Supabase stack. Exercises the authoritative layer-0
// resolver resolve_round(uuid) (supabase/migrations/
// 0078_resolve_round_authoritative.sql, issue #305) directly: seed a round's
// rolls and Cast Log, call resolve_round(uuid), and assert the brewer it
// picks, the Resolution Trace it emits, and its idempotence. Asserts on
// externally observable outcomes only (spec section: Testing Decisions).

describe.skipIf(!hasAnonTestEnv)("Saving Steep catalog row", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  // ----------------------------------------------------------------------
  // Saving Steep natural-1 backfire (issue #308, spec §8).
  // ----------------------------------------------------------------------

  it("Saving Steep is a live catalog card with a contested_negate {dc:10, backfire} effect and a deck instance", async () => {
    const { data: card } = await admin.from("spell_cards").select("id").eq("name", "Saving Steep").single();
    const { data: effects } = await admin
      .from("spell_card_effects").select("effect_kind, effect_params").eq("card_id", card!.id);
    expect(effects).toEqual([{ effect_kind: "contested_negate", effect_params: { dc: 10, backfire: true } }]);
    const { data: instances } = await admin
      .from("spell_deck_instances").select("location").eq("card_id", card!.id);
    expect(instances!.length).toBeGreaterThan(0);
    expect(instances!.every((i) => i.location !== "benched")).toBe(true);
  });

  // ==========================================================================
  // Phase 4b: persistent modifier delta projection + the room_players.modifier
  // log-derived cache (issue #311, spec §9).
  // ==========================================================================
});
