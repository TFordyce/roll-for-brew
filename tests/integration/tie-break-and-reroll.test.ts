import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveLayer, type LayerEntry } from "../../src/lib/game/resolveLayer";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// reroll-layer RPCs (supabase/migrations/0007_reroll_layers.sql) — submit_roll's
// layer-generic behaviour, get_current_layer_rolls_if_complete,
// advance_round_layer, and resolve_round off a non-zero layer — the same
// way the app drives them via src/app/rounds/actions.ts:submitRollAction.
//
// Die values are generated server-side by submit_roll, so a deterministic
// multi-layer tie can't be produced by calling it directly (see
// roll-and-resolve.test.ts's isSpecialCase skip). Instead this test seeds
// `rolls` rows directly as the admin (service-role) client — bypassing only
// the random value generation, not any of the actual gating logic under
// test — to force: a non-nat tie at layer 0, a nat-1 tie at layer 1, and a
// nat-1 outright win at layer 2.
describe.skipIf(!hasAnonTestEnv)("tie-break and nat-1/nat-20 recursion", () => {
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

  async function seedRoll(
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

  type CompletedLayerRow = { layer: number; player_id: string; value: number; modifier_snapshot: number };

  async function getCompletedLayer(client: SupabaseClient, roundId: string) {
    const { data, error } = await client.rpc("get_current_layer_rolls_if_complete", {
      p_round_id: roundId,
    });
    expect(error).toBeNull();
    return data as CompletedLayerRow[];
  }

  it("resolves a multi-layer tie (including a nat-1 tie) to a single brewer, off whichever layer it finally resolves on", async () => {
    const a = await signUp("reroll-a");
    const b = await signUp("reroll-b");
    const c = await signUp("reroll-c");

    const { data: roundId } = await a.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await b.client.rpc("declare_in", { p_round_id: roundId });
    await c.client.rpc("declare_in", { p_round_id: roundId });
    const { error: closeError } = await a.client.rpc("close_round", { p_round_id: roundId });
    expect(closeError).toBeNull();

    // Layer 0: a wins clear of the tie (total 15); b and c tie on total 10.
    await seedRoll(roundId, a.googleSub, 0, 15, 0);
    await seedRoll(roundId, b.googleSub, 0, 7, 3);
    await seedRoll(roundId, c.googleSub, 0, 4, 6);

    const layer0Rows = await getCompletedLayer(a.client, roundId);
    expect(layer0Rows).toHaveLength(3);
    expect(layer0Rows.every((r) => r.layer === 0)).toBe(true);

    const layer0Outcome = resolveLayer(
      layer0Rows.map((r): LayerEntry => ({ playerId: r.player_id, roll: r.value, modifier: r.modifier_snapshot })),
    );
    expect(layer0Outcome).toEqual({ outcome: "tie", tiedPlayerIds: [b.googleSub, c.googleSub] });

    const { data: nextLayerAfter0, error: advance0Error } = await b.client.rpc("advance_round_layer", {
      p_round_id: roundId,
      p_tied_player_ids: (layer0Outcome as { tiedPlayerIds: string[] }).tiedPlayerIds,
    });
    expect(advance0Error).toBeNull();
    expect(nextLayerAfter0).toBe(1);

    // a is not part of the reroll — pure spectator, no action available: a's
    // device can't read or submit for the tied players' layer.
    const { error: aSpectateReadError } = await a.client.rpc("get_current_layer_rolls_if_complete", {
      p_round_id: roundId,
    });
    expect(aSpectateReadError).not.toBeNull();

    const { error: aSpectateRollError } = await a.client.rpc("submit_roll", { p_round_id: roundId });
    expect(aSpectateRollError).not.toBeNull();

    // Layer 1: b and c both roll nat-1 with the same modifier — ties again,
    // this time via the nat-1 tie-break branch rather than a plain total.
    await seedRoll(roundId, b.googleSub, 1, 1, 3);
    await seedRoll(roundId, c.googleSub, 1, 1, 3);

    const layer1Rows = await getCompletedLayer(b.client, roundId);
    expect(layer1Rows).toHaveLength(2);
    expect(layer1Rows.every((r) => r.layer === 1)).toBe(true);

    const layer1Outcome = resolveLayer(
      layer1Rows.map((r): LayerEntry => ({ playerId: r.player_id, roll: r.value, modifier: r.modifier_snapshot })),
    );
    expect(layer1Outcome).toEqual({ outcome: "tie", tiedPlayerIds: [b.googleSub, c.googleSub] });

    const { data: nextLayerAfter1, error: advance1Error } = await c.client.rpc("advance_round_layer", {
      p_round_id: roundId,
      p_tied_player_ids: (layer1Outcome as { tiedPlayerIds: string[] }).tiedPlayerIds,
    });
    expect(advance1Error).toBeNull();
    expect(nextLayerAfter1).toBe(2);

    // Layer 2: b rolls a nat-1 (brews outright regardless of modifier), c
    // doesn't — a single brewer finally emerges, two layers deep.
    await seedRoll(roundId, b.googleSub, 2, 1, 3);
    await seedRoll(roundId, c.googleSub, 2, 9, 6);

    const layer2Rows = await getCompletedLayer(b.client, roundId);
    expect(layer2Rows).toHaveLength(2);
    expect(layer2Rows.every((r) => r.layer === 2)).toBe(true);

    const layer2Outcome = resolveLayer(
      layer2Rows.map((r): LayerEntry => ({ playerId: r.player_id, roll: r.value, modifier: r.modifier_snapshot })),
    );
    expect(layer2Outcome).toEqual({ outcome: "brewer", playerId: b.googleSub });

    // Final write path: resolve_round must fire off layer 2's outcome, not
    // just layer 0 — cups_made is still the round's full 3-participant
    // count regardless of how many reroll layers it took.
    const { error: resolveError } = await b.client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: b.googleSub,
      p_cups_made: 3,
    });
    expect(resolveError).toBeNull();

    const { data: round, error: roundError } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made, current_layer, resolved_at")
      .eq("id", roundId)
      .single();
    expect(roundError).toBeNull();
    expect(round).toMatchObject({
      status: "resolved",
      brewer_id: b.googleSub,
      cups_made: 3,
      current_layer: 2,
    });
    expect(round!.resolved_at).not.toBeNull();

    const { data: roomPlayer, error: roomPlayerError } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", a.roomId)
      .eq("player_id", b.googleSub)
      .single();
    expect(roomPlayerError).toBeNull();
    expect(roomPlayer!.modifier).toBe(3);
  });

  it("advance_round_layer rejects a player who didn't roll the current layer", async () => {
    const a = await signUp("advance-guard-a");
    const b = await signUp("advance-guard-b");
    const outsider = await signUp("advance-guard-outsider");

    const { data: roundId } = await a.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await b.client.rpc("declare_in", { p_round_id: roundId });
    await a.client.rpc("close_round", { p_round_id: roundId });

    await seedRoll(roundId, a.googleSub, 0, 10, 0);
    await seedRoll(roundId, b.googleSub, 0, 10, 0);

    const { error } = await a.client.rpc("advance_round_layer", {
      p_round_id: roundId,
      p_tied_player_ids: [a.googleSub, outsider.googleSub],
    });
    expect(error).not.toBeNull();

    const { data: round } = await admin.from("rounds").select("current_layer").eq("id", roundId).single();
    expect(round?.current_layer).toBe(0);
  });
});
