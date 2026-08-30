import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BENCHED_SPELL_CARDS,
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Migration 0074 (issue #284): the 39 non-working spell cards are parked at
// location 'benched' so draw_spell_card — which only ever picks a row where
// location = 'in_deck' — can never hand one to a player. Catalog/collection
// reads are unaffected (they read spell_cards, not the deck).
//
// The assertions here are deliberately about *invariants*, not the exact
// count 39: the un-benching follow-ups (Kettle Crash #285, Yorkshire Terror
// #286, then T2) each flip one card back to 'in_deck', so "how many are
// benched" is a moving target. What must always hold is that nothing
// outside the documented list is ever benched, and that a benched card is
// never drawn.
describe.skipIf(!hasAnonTestEnv)("spell cards: non-working cards benched from the draw pool", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  async function benchedCardNames(): Promise<string[]> {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("spell_cards!inner(name)")
      .eq("location", "benched");
    if (error) throw error;
    return (data as unknown as { spell_cards: { name: string } }[]).map(
      (r) => r.spell_cards.name,
    );
  }

  it("benches only cards from the documented non-working list", async () => {
    // Guards against the setup.ts list drifting from migration 0074's,
    // which enumerates 39 names (37 with no effect rows + 2 dead kinds).
    expect(new Set(BENCHED_SPELL_CARDS).size).toBe(39);

    const documented = new Set<string>(BENCHED_SPELL_CARDS);
    const benched = await benchedCardNames();

    expect(benched.length).toBeGreaterThan(0);
    for (const name of benched) {
      expect(documented.has(name)).toBe(true);
    }
    // No duplicates — one deck instance per catalog card.
    expect(new Set(benched).size).toBe(benched.length);
  });

  it("leaves the deck + bench partitioning all 71 instances", async () => {
    const { data: rows, error } = await admin
      .from("spell_deck_instances")
      .select("location");
    expect(error).toBeNull();

    const byLocation = (rows as { location: string }[]).reduce<Record<string, number>>(
      (acc, r) => ((acc[r.location] = (acc[r.location] ?? 0) + 1), acc),
      {},
    );
    const total = Object.values(byLocation).reduce((a, b) => a + b, 0);
    expect(total).toBe(71);
    expect(byLocation.benched ?? 0).toBeGreaterThan(0);
    expect(byLocation.in_deck ?? 0).toBeGreaterThan(0);
  });

  it("keeps all 71 cards visible in the catalog", async () => {
    const { count } = await admin
      .from("spell_cards")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(71);
  });

  it("rejects an unknown location value now that the check constraint is rewritten", async () => {
    const { data: someInstance } = await admin
      .from("spell_deck_instances")
      .select("id")
      .eq("location", "in_deck")
      .limit(1)
      .single();

    const { error } = await admin
      .from("spell_deck_instances")
      .update({ location: "shelf" })
      .eq("id", someInstance!.id);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514"); // check_violation
  });

  it("never draws a benched card across many draws", async () => {
    const { client } = await signUpSignInAndEnterRoom(admin, cleanup, "bench-draw-loop");

    for (let i = 0; i < 50; i++) {
      const benchedNow = new Set(await benchedCardNames());

      const { data, error } = await client.rpc("draw_spell_card", { p_trigger: "nat1" });
      expect(error).toBeNull();
      const [row] = data as { instance_id: string }[];

      const { data: instance } = await admin
        .from("spell_deck_instances")
        .select("spell_cards!inner(name)")
        .eq("id", row!.instance_id)
        .single();
      const name = (instance as unknown as { spell_cards: { name: string } }).spell_cards.name;
      expect(benchedNow.has(name)).toBe(false);

      // Reshuffle it so the next iteration draws from the full deck again.
      await admin
        .from("spell_deck_instances")
        .update({ location: "in_deck", held_by_player: null })
        .eq("id", row!.instance_id);
    }
  });
});
