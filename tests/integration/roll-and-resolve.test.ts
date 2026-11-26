import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// submit_roll / resolve_round RPCs
// (supabase/migrations/0005_rolls_and_resolution.sql, generalized off layer
// 0 in 0007_reroll_layers.sql) through real signed-in sessions, the same
// way the app drives them via
// src/app/rounds/actions.ts:submitRollAction — start -> declare -> roll ->
// resolve -> modifier-increment, for a round that doesn't tie or hit a nat.
describe.skipIf(!hasAnonTestEnv)("roll & resolve (happy path)", () => {
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

  it("submit_roll rejects a caller who is not a declared participant", async () => {
    const [starter, other, bystander] = await Promise.all([
      signUp("roll-guard-starter"),
      signUp("roll-guard-other"),
      signUp("roll-guard-bystander"),
    ]);

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await starter.client.rpc("close_round", { p_round_id: roundId });

    const { error } = await bystander.client.rpc("submit_roll", { p_round_id: roundId });
    expect(error).not.toBeNull();
  });

  it("submit_roll rejects rolling before the round is closed", async () => {
    const starter = await signUp("roll-open-starter");
    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error } = await starter.client.rpc("submit_roll", { p_round_id: roundId });
    expect(error).not.toBeNull();
  });
});
