import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #431 (spec #401, design #380):
// Loose Leaf -- "When you are named tea-maker, force a roll-off against the
// second-lowest roller. Both roll d20 -- the loser makes tea instead."
//
//   * Cast into the layer-0 Reaction Window, it arms a
//     `named_tea_maker_rolloff` Cast Log row aimed at the caster.
//   * Tea-maker selection naming the holder, by any tier, returns an
//     unfinished `rolloff` against the second-lowest layer-0 roller (roll,
//     then modifier, then player id). finalize_layer commits it like a tie --
//     a Tie-Break Reroll Layer for the two -- and returns a tie-shaped outcome
//     marked `rolloff`.
//   * At that Layer the lower roll brews, with normal modifier gain; a tied
//     roll-off goes to another Layer.
//   * No distinct second-lowest (a two-player round) -> the card does nothing.
// Assertions are on observable outcomes: finalize_layer's result, the round
// row, the Resolution Trace and the brewer's modifier.

type TraceStep = {
  display_kind: string;
  target_player: string | null;
  after: { type: string; value: number | string | null };
  outcome: string;
  rolloff_opponent_id?: string;
  rolloff_reason?: string;
};

type Finalization = {
  outcome: "brewer" | "tie" | "noop";
  layer?: number;
  brewer_id?: string;
  tied_player_ids?: string[];
  rolloff?: boolean;
  reason?: string;
};

const LOOSE_LEAF = "Loose Leaf";

describe.skipIf(!hasAnonTestEnv)("Loose Leaf (#431)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  type Player = Awaited<ReturnType<typeof signUpSignInAndEnterRoom>>;

  /** Signs up the players into their own room so no stranger joins a round. */
  async function players<const L extends readonly string[]>(...labels: L): Promise<{ [K in keyof L]: Player }> {
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `loose-leaf-${l}`)));
    const roomId = await seedDedicatedRoom(
      admin,
      cleanup,
      ps.map((p) => p.googleSub),
    );
    return ps.map((p) => ({ ...p, roomId })) as { [K in keyof L]: Player };
  }

  async function openAndCloseRound(starter: Player, others: Player[]): Promise<string> {
    const { data: roundId, error } = await starter.client.rpc("start_round", { p_room_id: starter.roomId });
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    const { error: cErr } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(cErr).toBeNull();
    return roundId as string;
  }

  async function seedRoll(roundId: string, playerId: string, value: number, layer = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer,
      value,
      input_mode: "manual",
      modifier_snapshot: 0,
    });
    expect(error).toBeNull();
  }

  /**
   * Seeds layer 0's rolls with `holder` holding Loose Leaf -- the only
   * Reaction-card holder -- opens the window and casts it, which closes the
   * window. Finalization is left to the test.
   */
  async function armedRound(holder: Player, others: Player[], rolls: [Player, number][]): Promise<string> {
    await forceHold(admin, holder.googleSub, LOOSE_LEAF);
    const roundId = await openAndCloseRound(holder, others);
    for (const [p, v] of rolls) await seedRoll(roundId, p.googleSub, v);

    const { error: openError } = await holder.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });
    expect(openError).toBeNull();
    const { error: castError } = await holder.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();
    return roundId;
  }

  async function finalize(by: Player, roundId: string): Promise<Finalization> {
    const { data, error } = await by.client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as Finalization;
  }

  async function roundRow(roundId: string) {
    const { data, error } = await admin
      .from("rounds")
      .select("status, current_layer, brewer_id, brewer_modifier_gain, resolution_trace")
      .eq("id", roundId)
      .single();
    if (error) throw error;
    return data as {
      status: string;
      current_layer: number;
      brewer_id: string | null;
      brewer_modifier_gain: number | null;
      resolution_trace: TraceStep[] | null;
    };
  }

  async function modifierOf(p: Player): Promise<number> {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", p.roomId)
      .eq("player_id", p.googleSub)
      .single();
    if (error) throw error;
    return Number((data as { modifier: number }).modifier);
  }

  function rolloffStep(trace: TraceStep[] | null): TraceStep | undefined {
    return (trace ?? []).find((s) => s.display_kind === "named_tea_maker_rolloff");
  }

  it("the holder named Tea Maker rolls off against the second-lowest roller, and the loser brews with normal gain", async () => {
    const [holder, second, high] = await players("holder", "second", "high");
    const roundId = await armedRound(holder, [second, high], [
      [holder, 3],
      [second, 9],
      [high, 18],
    ]);

    const rolloff = await finalize(second, roundId);
    expect(rolloff).toEqual({
      outcome: "tie",
      layer: 1,
      tied_player_ids: [holder.googleSub, second.googleSub],
      rolloff: true,
    });

    const mid = await roundRow(roundId);
    expect(mid.status).toBe("closed");
    expect(mid.current_layer).toBe(1);
    expect(mid.brewer_id).toBeNull();
    expect(rolloffStep(mid.resolution_trace)).toMatchObject({
      target_player: holder.googleSub,
      after: { type: "status", value: "rolloff" },
      outcome: "applied",
      rolloff_opponent_id: second.googleSub,
    });

    // The roll-off: the holder rolls higher, so the second-lowest roller brews.
    const secondBefore = await modifierOf(second);
    await seedRoll(roundId, holder.googleSub, 15, 1);
    await seedRoll(roundId, second.googleSub, 4, 1);
    const done = await finalize(second, roundId);
    expect(done).toMatchObject({ outcome: "brewer", layer: 1, brewer_id: second.googleSub });

    const after = await roundRow(roundId);
    expect(after.status).toBe("resolved");
    expect(after.brewer_id).toBe(second.googleSub);
    expect(after.brewer_modifier_gain).toBe(3);
    expect(await modifierOf(second)).toBe(secondBefore + 3);
    // The layer-0 Trace the round keeps still explains the roll-off.
    expect(rolloffStep(after.resolution_trace)?.rolloff_opponent_id).toBe(second.googleSub);
  });

  it("a tied roll-off goes to another Layer, and the holder brews if they lose it", async () => {
    const [holder, second, high] = await players("tied-holder", "tied-second", "tied-high");
    const roundId = await armedRound(holder, [second, high], [
      [holder, 2],
      [second, 7],
      [high, 16],
    ]);
    expect(await finalize(holder, roundId)).toMatchObject({ outcome: "tie", layer: 1, rolloff: true });

    await seedRoll(roundId, holder.googleSub, 10, 1);
    await seedRoll(roundId, second.googleSub, 10, 1);
    const again = await finalize(holder, roundId);
    expect(again).toMatchObject({ outcome: "tie", layer: 2, rolloff: false });
    expect([...(again.tied_player_ids ?? [])].sort()).toEqual([holder.googleSub, second.googleSub].sort());

    await seedRoll(roundId, holder.googleSub, 3, 2);
    await seedRoll(roundId, second.googleSub, 17, 2);
    expect(await finalize(holder, roundId)).toMatchObject({ outcome: "brewer", layer: 2, brewer_id: holder.googleSub });
    expect((await roundRow(roundId)).brewer_modifier_gain).toBe(3);
  });

  it("does nothing in a two-player round -- there's no distinct second-lowest roller", async () => {
    const [holder, other] = await players("duo-holder", "duo-other");
    const roundId = await armedRound(holder, [other], [
      [holder, 4],
      [other, 13],
    ]);

    expect(await finalize(other, roundId)).toMatchObject({ outcome: "brewer", layer: 0, brewer_id: holder.googleSub });
    const round = await roundRow(roundId);
    expect(round.status).toBe("resolved");
    expect(rolloffStep(round.resolution_trace)).toMatchObject({
      target_player: holder.googleSub,
      after: { type: "status", value: "no effect" },
      outcome: "no-op",
      rolloff_reason: "no_second_lowest",
    });
  });

  it("does nothing when its holder isn't named Tea Maker", async () => {
    const [low, holder, high] = await players("unnamed-low", "unnamed-holder", "unnamed-high");
    const roundId = await armedRound(holder, [low, high], [
      [low, 2],
      [holder, 11],
      [high, 19],
    ]);

    expect(await finalize(low, roundId)).toMatchObject({ outcome: "brewer", layer: 0, brewer_id: low.googleSub });
    expect(rolloffStep((await roundRow(roundId)).resolution_trace)).toBeUndefined();
  });

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
