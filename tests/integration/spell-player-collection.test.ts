import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceDraw,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

type CollectionRow = {
  card_id: string;
  name: string;
  casting_time: "A" | "R" | null;
  target: string | null;
  tier: "common" | "rare" | "epic";
  effect_text: string | null;
  draw_count: number;
};

// Runs against a real, dedicated test Supabase project. Exercises
// get_player_spell_collection (0039, issue #133, child of the Spell
// Collection page spec #130).
describe.skipIf(!hasAnonTestEnv)("get_player_spell_collection", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;
  let catalogSize: number;

  beforeAll(async () => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);

    const { count } = await admin.from("spell_cards").select("*", { count: "exact", head: true });
    catalogSize = count!;
    expect(catalogSize).toBeGreaterThanOrEqual(71);
  });

  afterEach(() => cleanup.run());

  function signUpSignInAndEnter(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }

  it("a fresh player's own collection has every catalog card undiscovered", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("collection-fresh-self");

    const { data, error } = await client.rpc("get_player_spell_collection", {
      p_player_id: googleSub,
    });
    expect(error).toBeNull();

    const rows = data as CollectionRow[];
    expect(rows).toHaveLength(catalogSize);
    for (const row of rows) {
      expect(row.name).toBeTruthy();
      expect(row.tier).toBeTruthy();
      expect(row.draw_count).toBe(0);
      expect(row.casting_time).toBeNull();
      expect(row.target).toBeNull();
      expect(row.effect_text).toBeNull();
    }
  });

  it("a drawn card's row flips to populated fields and draw_count increments on repeat draws", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("collection-drawn");
    await forceDraw(admin, googleSub, "Lucky Sip");

    const { data, error } = await client.rpc("get_player_spell_collection", {
      p_player_id: googleSub,
    });
    expect(error).toBeNull();

    const rows = data as CollectionRow[];
    expect(rows).toHaveLength(catalogSize);

    const luckySip = rows.find((r) => r.name === "Lucky Sip")!;
    expect(luckySip.draw_count).toBe(1);
    expect(luckySip.casting_time).toBe("A");
    expect(luckySip.target).toBe("SELF");
    expect(luckySip.effect_text).toBeTruthy();

    const undrawn = rows.find((r) => r.name !== "Lucky Sip")!;
    expect(undrawn.draw_count).toBe(0);
    expect(undrawn.casting_time).toBeNull();

    await forceDraw(admin, googleSub, "Lucky Sip");
    const { data: secondData } = await client.rpc("get_player_spell_collection", {
      p_player_id: googleSub,
    });
    const secondLuckySip = (secondData as CollectionRow[]).find((r) => r.name === "Lucky Sip")!;
    expect(secondLuckySip.draw_count).toBe(2);
  });

  it("a Test Player's id returns an all-undiscovered collection even with recorded draws", async () => {
    const testPlayerId = "test-player-1";
    await forceDraw(admin, testPlayerId, "Lucky Sip");

    try {
      const { client } = await signUpSignInAndEnter("collection-vs-test-player");
      const { data, error } = await client.rpc("get_player_spell_collection", {
        p_player_id: testPlayerId,
      });
      expect(error).toBeNull();

      const rows = data as CollectionRow[];
      expect(rows).toHaveLength(catalogSize);
      for (const row of rows) {
        expect(row.draw_count).toBe(0);
      }
    } finally {
      await admin.from("spell_draws").delete().eq("player_id", testPlayerId);
    }
  });

  it("any authenticated player can call this for any other player's id", async () => {
    const { googleSub: ownerSub } = await signUpSignInAndEnter("collection-owner");
    await forceDraw(admin, ownerSub, "Lucky Sip");
    const { client: viewerClient } = await signUpSignInAndEnter("collection-viewer");

    const { data, error } = await viewerClient.rpc("get_player_spell_collection", {
      p_player_id: ownerSub,
    });
    expect(error).toBeNull();

    const rows = data as CollectionRow[];
    const luckySip = rows.find((r) => r.name === "Lucky Sip")!;
    expect(luckySip.draw_count).toBe(1);
  });
});
