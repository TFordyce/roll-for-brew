import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// spell_draws site-wide read RLS policy (0039) — any authenticated player
// can read another player's spell_draws rows, excluding test players' rows.
describe.skipIf(!hasAnonTestEnv)("spell_draws: site-wide read RLS policy", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  function signUpSignInAndEnter(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }

  async function drawACard(client: SupabaseClient, roundId: string) {
    await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat1" });
    const { error } = await client.rpc("draw_pending_spell_card", { p_round_id: roundId });
    if (error) throw error;
  }

  it("a second signed-in player can read a player's spell_draws rows", async () => {
    const { client: drawer, googleSub: drawerId } = await signUpSignInAndEnter("draws-drawer");
    const { data: roundId, error: roundError } = await drawer.rpc("start_round");
    if (roundError) throw roundError;
    cleanup.trackRound(roundId as string);
    await drawACard(drawer, roundId as string);

    const { client: viewer } = await signUpSignInAndEnter("draws-viewer");
    const { data, error } = await viewer
      .from("spell_draws")
      .select("player_id")
      .eq("player_id", drawerId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.player_id).toBe(drawerId);
  });

  it("excludes a Test Player's spell_draws rows from what any caller sees", async () => {
    const { client: testClient, googleSub: testPlayerId } = await signUpSignInAndEnter("draws-test-player");
    const { error: markTestError } = await admin
      .from("players")
      .update({ is_test: true })
      .eq("id", testPlayerId);
    if (markTestError) throw markTestError;

    const { data: roundId, error: roundError } = await testClient.rpc("start_round");
    if (roundError) throw roundError;
    cleanup.trackRound(roundId as string);
    await drawACard(testClient, roundId as string);

    const { client: viewer } = await signUpSignInAndEnter("draws-test-viewer");
    const { data, error } = await viewer
      .from("spell_draws")
      .select("player_id")
      .eq("player_id", testPlayerId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
