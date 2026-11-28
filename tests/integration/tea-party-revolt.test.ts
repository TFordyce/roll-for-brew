import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
  closeRoundAs,
  declareInAs,
  startRoundAs,
} from "./setup";

// Runs against a real local Supabase stack. Exercises Tea Party Revolt (issue
// #430, spec #401): "The lowest roller chooses who makes tea this round."
//
// A table-wide tea_maker_override in mode `chosen` whose target is named after
// layer 0 is rolled, by the lowest layer-0 roller (a tie goes to the tied
// roller with the smallest player id), through set_tea_party_revolt_target.
// Layer 0 is held incomplete while the pick is outstanding, so neither
// advance_layer nor finalize_layer does anything (noop reason
// `revolt_pick_pending`). A stalled pick is abandoned: the cast is treated as
// negated and the default lowest roller brews.
//
// Assertions are on observable outcomes only: the RPC errors, the advancement
// outcomes, rounds.brewer_id and the Resolution Trace.

describe.skipIf(!hasAnonTestEnv)("Tea Party Revolt (issue #430)", () => {
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

  type Player = Awaited<ReturnType<typeof signUp>>;

  /** Three players, sorted by player id so a test can pick the tie-break winner. */
  async function threePlayers() {
    const players = [await signUp("a"), await signUp("b"), await signUp("c")];
    return players.sort((x, y) => (x.googleSub < y.googleSub ? -1 : 1)) as [Player, Player, Player];
  }

  async function startRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await startRoundAs(starter.client);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await declareInAs(o.client, roundId);
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  /** `caster` plays Tea Party Revolt through the real RPC, before close. */
  async function castRevolt(roundId: string, caster: Player) {
    await forceHold(admin, caster.googleSub, "Tea Party Revolt");
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  async function closeRound(starter: Player, roundId: string) {
    const { error } = await closeRoundAs(roundId);
    expect(error).toBeNull();
  }

  async function seedRoll(roundId: string, playerId: string, value: number) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: 0,
    });
    expect(error).toBeNull();
  }

  /** A round where players[0] casts Tea Party Revolt and everyone has rolled layer 0. */
  async function revoltRound(players: [Player, Player, Player], rolls: [number, number, number]) {
    const [caster, ...others] = players;
    const roundId = await startRound(caster, others);
    await castRevolt(roundId, caster);
    await closeRound(caster, roundId);
    for (const [i, p] of players.entries()) await seedRoll(roundId, p.googleSub, rolls[i]!);
    return roundId;
  }

  /** Backdates close by more than the 5-minute stall clock. */
  async function stallRound(roundId: string) {
    const { error } = await admin
      .from("rounds")
      .update({ closed_at: new Date(Date.now() - 6 * 60_000).toISOString() })
      .eq("id", roundId);
    expect(error).toBeNull();
  }

  function pick(picker: Player, roundId: string, target: Player) {
    return picker.client.rpc("set_tea_party_revolt_target", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
  }

  it("is live: no longer benched, and casting it needs no target", async () => {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "Tea Party Revolt");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.some((r) => r.location === "benched")).toBe(false);
  });

  it("only the lowest roller can record the pick; anyone else is rejected", async () => {
    const [p0, p1, p2] = await threePlayers();
    // p1 rolls lowest.
    const roundId = await revoltRound([p0, p1, p2], [12, 4, 17]);

    const byCaster = await pick(p0, roundId, p2);
    expect(byCaster.error?.message).toMatch(/only the lowest roller/i);
    const byHigh = await pick(p2, roundId, p0);
    expect(byHigh.error?.message).toMatch(/only the lowest roller/i);

    const byLowest = await pick(p1, roundId, p2);
    expect(byLowest.error).toBeNull();

    // Once made, the pick can't be made again.
    const again = await pick(p1, roundId, p0);
    expect(again.error?.message).toMatch(/no tea party revolt pick/i);
  });

  it("a tie for lowest goes to the tied roller with the smallest player id", async () => {
    const [p0, p1, p2] = await threePlayers();
    // p1 and p2 tie for lowest; p1 has the smaller id.
    const roundId = await revoltRound([p0, p1, p2], [15, 5, 5]);

    const byLargerId = await pick(p2, roundId, p0);
    expect(byLargerId.error?.message).toMatch(/only the lowest roller/i);
    const bySmallerId = await pick(p1, roundId, p0);
    expect(bySmallerId.error).toBeNull();
  });

  it("can't pick before layer 0 is fully rolled", async () => {
    const [p0, p1, p2] = await threePlayers();
    const roundId = await startRound(p0, [p1, p2]);
    await castRevolt(roundId, p0);
    await closeRound(p0, roundId);
    await seedRoll(roundId, p0.googleSub, 9);
    await seedRoll(roundId, p1.googleSub, 2);

    const early = await pick(p1, roundId, p2);
    expect(early.error?.message).toMatch(/not everyone has rolled/i);
  });

  it("the pick must name a participant of the round", async () => {
    const [p0, p1, p2] = await threePlayers();
    const outsider = await signUp("outsider");
    const roundId = await revoltRound([p0, p1, p2], [12, 4, 17]);

    const res = await pick(p1, roundId, outsider);
    expect(res.error?.message).toMatch(/not a participant/i);
  });

  it("the pick can't name a participant who was excluded", async () => {
    const [p0, p1, p2] = await threePlayers();
    const roundId = await revoltRound([p0, p1, p2], [12, 4, 17]);
    const { error: xErr } = await admin
      .from("round_participants")
      .update({ excluded_at: new Date().toISOString() })
      .eq("round_id", roundId)
      .eq("player_id", p2.googleSub);
    expect(xErr).toBeNull();

    const res = await pick(p1, roundId, p2);
    expect(res.error?.message).toMatch(/not a participant/i);
  });

  it("stall recovery is a no-op when no pick is outstanding", async () => {
    const [p0, p1, p2] = await threePlayers();
    const roundId = await revoltRound([p0, p1, p2], [12, 4, 17]);
    expect((await pick(p1, roundId, p0)).error).toBeNull();
    await stallRound(roundId);

    const { data, error } = await p2.client.rpc("resolve_stalled_revolt_picks", { p_round_id: roundId });
    expect(error).toBeNull();
    expect(data).toBe(0);
  });

  it("nobody can abandon the pick before the stall clock runs out", async () => {
    const [p0, p1, p2] = await threePlayers();
    const roundId = await revoltRound([p0, p1, p2], [12, 4, 17]);

    const { data, error } = await p2.client.rpc("resolve_stalled_revolt_picks", { p_round_id: roundId });
    expect(error).toBeNull();
    expect(data).toBe(0);
    // The pick is still the lowest roller's to make.
    expect((await pick(p1, roundId, p2)).error).toBeNull();
  });

  it("get_tea_party_revolt_picker names the lowest roller only once layer 0 is rolled", async () => {
    const [p0, p1, p2] = await threePlayers();
    const roundId = await startRound(p0, [p1, p2]);
    await castRevolt(roundId, p0);
    await closeRound(p0, roundId);
    await seedRoll(roundId, p0.googleSub, 9);
    await seedRoll(roundId, p1.googleSub, 2);

    const before = await p0.client.rpc("get_tea_party_revolt_picker", { p_round_id: roundId });
    expect(before.error).toBeNull();
    expect(before.data).toBeNull();

    await seedRoll(roundId, p2.googleSub, 14);
    const after = await p0.client.rpc("get_tea_party_revolt_picker", { p_round_id: roundId });
    expect(after.error).toBeNull();
    expect(after.data).toBe(p1.googleSub);

    expect((await pick(p1, roundId, p2)).error).toBeNull();
    const picked = await p0.client.rpc("get_tea_party_revolt_picker", { p_round_id: roundId });
    expect(picked.data).toBeNull();
  });
});
