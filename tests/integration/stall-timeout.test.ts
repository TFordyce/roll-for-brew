import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enforceStallTimeout } from "../../src/app/rounds/stallEnforcement";
import { STALL_TIMEOUT_MS } from "../../src/lib/game/stallTimeout";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises
// enforceStallTimeout (src/app/rounds/stallEnforcement.ts) against the RPCs
// added in supabase/migrations/0009_stall_timeout.sql. Real elapsed time
// isn't waited out — enforceStallTimeout's `now` parameter is injected as a
// fixed instant STALL_TIMEOUT_MS+ after real setup, which is exactly what
// makes this testable without sleeping ~2 minutes per test.
function future() {
  return new Date(Date.now() + STALL_TIMEOUT_MS + 5_000);
}

async function seedRoll(
  admin: SupabaseClient,
  roundId: string,
  playerId: string,
  layer: number,
  value: number,
  modifierSnapshot: number,
) {
  const { error } = await admin.from("rolls").insert({
    round_id: roundId,
    player_id: playerId,
    layer,
    value,
    input_mode: "manual",
    modifier_snapshot: modifierSnapshot,
  });
  expect(error).toBeNull();
}

describe.skipIf(!hasAnonTestEnv)("stall-timeout enforcement", () => {
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

  it("cancels an open round whose starter never closes declarations", async () => {
    const a = await signUp("stall-open-a");

    const { data: roundId } = await a.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const outcome = await enforceStallTimeout(a.client, roundId as string, future);
    expect(outcome).toEqual({ action: "cancelled" });

    const { data: round } = await admin.from("rounds").select("status").eq("id", roundId).single();
    expect(round?.status).toBe("cancelled");
  });

  it("does not cancel an open round before the timeout has elapsed", async () => {
    const a = await signUp("stall-open-fresh-a");

    const { data: roundId } = await a.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const outcome = await enforceStallTimeout(a.client, roundId as string, () => new Date());
    expect(outcome).toEqual({ action: "none" });

    const { data: round } = await admin.from("rounds").select("status").eq("id", roundId).single();
    expect(round?.status).toBe("open");
  });

  it("excludes a declared player who never rolls and resolves the round off the rest", async () => {
    const a = await signUp("stall-roll-a");
    const b = await signUp("stall-roll-b");
    const c = await signUp("stall-roll-c");

    const { data: roundId } = await a.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await b.client.rpc("declare_in", { p_round_id: roundId });
    await c.client.rpc("declare_in", { p_round_id: roundId });
    await a.client.rpc("close_round", { p_round_id: roundId });

    // a and b roll; c stalls out.
    await seedRoll(admin, roundId, a.googleSub, 0, 15, 0);
    await seedRoll(admin, roundId, b.googleSub, 0, 7, 0);

    const outcome = await enforceStallTimeout(a.client, roundId as string, future);
    expect(outcome).toEqual({ action: "excluded", playerIds: [c.googleSub] });

    const { data: participant } = await admin
      .from("round_participants")
      .select("excluded_at")
      .eq("round_id", roundId)
      .eq("player_id", c.googleSub)
      .single();
    expect(participant?.excluded_at).not.toBeNull();

    // b rolled lowest (7 vs a's 15) among the two who actually rolled, so
    // resolution should proceed off just them, with cups_made still the
    // round's full 3-participant count.
    const { data: round } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made")
      .eq("id", roundId)
      .single();
    expect(round).toMatchObject({ status: "resolved", brewer_id: b.googleSub, cups_made: 3 });
  });

  it("excludes a stalled tie-break reroller and resolves off the remaining tied players", async () => {
    const a = await signUp("stall-tie-a");
    const b = await signUp("stall-tie-b");
    const c = await signUp("stall-tie-c");

    const { data: roundId } = await a.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await b.client.rpc("declare_in", { p_round_id: roundId });
    await c.client.rpc("declare_in", { p_round_id: roundId });
    await a.client.rpc("close_round", { p_round_id: roundId });

    // Layer 0: a wins clear (total 15); b and c tie on total 10.
    await seedRoll(admin, roundId, a.googleSub, 0, 15, 0);
    await seedRoll(admin, roundId, b.googleSub, 0, 7, 3);
    await seedRoll(admin, roundId, c.googleSub, 0, 4, 6);

    const { data: nextLayer, error: advanceError } = await b.client.rpc("advance_round_layer", {
      p_round_id: roundId,
      p_tied_player_ids: [b.googleSub, c.googleSub],
    });
    expect(advanceError).toBeNull();
    expect(nextLayer).toBe(1);

    // Layer 1: only b rolls; c stalls out of the reroll.
    await seedRoll(admin, roundId, b.googleSub, 1, 9, 3);

    const outcome = await enforceStallTimeout(a.client, roundId as string, future);
    expect(outcome).toEqual({ action: "excluded", playerIds: [c.googleSub] });

    const { data: layerParticipant } = await admin
      .from("round_layer_participants")
      .select("excluded_at")
      .eq("round_id", roundId)
      .eq("layer", 1)
      .eq("player_id", c.googleSub)
      .single();
    expect(layerParticipant?.excluded_at).not.toBeNull();

    // b is the sole remaining reroller, so resolveLayer treats them as the
    // outright brewer for layer 1 — cups_made still the full 3.
    const { data: round } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made, current_layer")
      .eq("id", roundId)
      .single();
    expect(round).toMatchObject({
      status: "resolved",
      brewer_id: b.googleSub,
      cups_made: 3,
      current_layer: 1,
    });
  });

  it("cancels the round instead of resolving when a stall exclusion drops active participants below 2", async () => {
    const a = await signUp("stall-cancel-a");
    const b = await signUp("stall-cancel-b");

    const { data: roundId } = await a.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await b.client.rpc("declare_in", { p_round_id: roundId });
    await a.client.rpc("close_round", { p_round_id: roundId });

    // Only a rolls; b stalls, and excluding them leaves just 1 active
    // participant — below the 2-player minimum, so the round cancels
    // outright rather than declaring a a solo "brewer".
    await seedRoll(admin, roundId, a.googleSub, 0, 12, 0);

    const outcome = await enforceStallTimeout(a.client, roundId as string, future);
    expect(outcome).toEqual({ action: "cancelled" });

    const { data: round } = await admin
      .from("rounds")
      .select("status, brewer_id")
      .eq("id", roundId)
      .single();
    expect(round).toMatchObject({ status: "cancelled", brewer_id: null });

    const { data: participant } = await admin
      .from("round_participants")
      .select("excluded_at")
      .eq("round_id", roundId)
      .eq("player_id", b.googleSub)
      .single();
    expect(participant?.excluded_at).not.toBeNull();
  });
});
