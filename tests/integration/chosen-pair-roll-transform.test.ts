import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Covers issue #318 -- Tier A primitive 2,
// the chosen-pair roll transform (migration 0096): swap / set-both-lower /
// set-both-higher over a caster-named pair, generalising roll_swap past the
// automatic highest<->lowest pick. Cards: Brew-tal Swap (Reaction, swap),
// Stir the Pot (Action, swap two OTHER players), Steaming Mug Bond (Action,
// min), Tea for Two (Action, max). Assertions are on externally observable
// outcomes only: the mutated rolls, the recorded cast_inputs.roll_transform,
// the emitted Resolution Trace, and the picked brewer.

type TraceStep = {
  index: number;
  display_kind: string;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  op?: string | null;
  ward_cast_id?: string | null;
  ward_card_name?: string | null;
  would_be_after?: number | string | null;
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  layer: number;
  brewer_id: string | null;
  brewer_source: string | null;
  tied_player_ids: string[] | null;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("chosen-pair roll transform (#318)", () => {
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

  async function seedRoll(roundId: string, playerId: string, value: number, modifierSnapshot = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: modifierSnapshot,
    });
    expect(error).toBeNull();
  }

  async function startRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function closeRound(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function openAndCloseRound(starter: Player, others: Player[]) {
    const roundId = await startRound(starter, others);
    await closeRound(starter, roundId);
    return roundId;
  }

  /** Force-hold a donor card, return it to the deck, and return its instance id. */
  async function donorInstance(playerId: string, donorCard: string) {
    const instanceId = await forceHold(admin, playerId, donorCard);
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    return instanceId;
  }

  async function openWindow(roundId: string, status: "open" | "closed" = "closed") {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  // A donor whose card text matches the op, so a seeded cast's card_instance_id
  // is not misleading (e.g. a `min` cast should not carry a Brew-tal Swap id).
  const DONOR_FOR_OP = { swap: "Brew-tal Swap", min: "Steaming Mug Bond", max: "Tea for Two" } as const;

  /** Seed a roll_pair_transform cast attached to a layer-0 window. */
  async function seedPairCast(
    roundId: string,
    casterId: string,
    op: "swap" | "min" | "max",
    pair: [string, string],
    windowId: string,
    targetPlayerId: string | null = null,
  ) {
    const instanceId = await donorInstance(casterId, DONOR_FOR_OP[op]);
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: casterId,
        card_instance_id: instanceId,
        target_player_id: targetPlayerId,
        target_pending: false,
        effect_kind: "roll_pair_transform",
        effect_params: { op },
        reaction_window_id: windowId,
        cast_inputs: { pair },
        target_role: targetPlayerId ? "TARGET" : "TABLE",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function seedWard(
    roomId: string,
    casterId: string,
    targetPlayerId: string,
    effectParams: Record<string, unknown>,
    cardName = "Cast-Iron Kettle",
  ) {
    const { effectId } = await seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId,
      casterId,
      cardName,
      effectKind: "ward",
      effectParams,
      roundsRemaining: 5,
    });
    return effectId;
  }

  // apply_roll_pair_transform is granted to `authenticated` (like apply_roll_swap),
  // so call it as a signed-in participant, not the service-role admin client.
  async function applyPair(client: SupabaseClient, roundId: string) {
    const { error } = await client.rpc("apply_roll_pair_transform", { p_round_id: roundId, p_layer: 0 });
    expect(error).toBeNull();
  }

  async function rollsById(roundId: string): Promise<Record<string, number>> {
    const { data } = await admin.from("rolls").select("player_id, value").eq("round_id", roundId).eq("layer", 0);
    return Object.fromEntries((data ?? []).map((r) => [r.player_id, r.value]));
  }

  async function castInputs(castId: string): Promise<Record<string, unknown>> {
    const { data } = await admin.from("spell_casts").select("cast_inputs").eq("id", castId).single();
    return (data!.cast_inputs ?? {}) as Record<string, unknown>;
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  function pairSteps(trace: TraceStep[]): TraceStep[] {
    return trace.filter((s) => s.display_kind === "roll_pair_transform");
  }

  // ----------------------------------------------------------------------
  // The mechanic: swap / min / max, adopted by resolve_round
  // ----------------------------------------------------------------------

  it("swap exchanges the caster-named pair's rolls and records before->after per player", async () => {
    const p1 = await signUp("cp-swap-1");
    const p2 = await signUp("cp-swap-2");
    const p3 = await signUp("cp-swap-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 18);
    await seedRoll(roundId, p2.googleSub, 4);
    await seedRoll(roundId, p3.googleSub, 11);
    const win = await openWindow(roundId);
    const castId = await seedPairCast(roundId, p1.googleSub, "swap", [p1.googleSub, p2.googleSub], win, p2.googleSub);

    await applyPair(p1.client, roundId);

    const rolls = await rollsById(roundId);
    expect(rolls[p1.googleSub]).toBe(4);
    expect(rolls[p2.googleSub]).toBe(18);
    expect(rolls[p3.googleSub]).toBe(11);

    const ci = await castInputs(castId);
    const rt = ci.roll_transform as { kind: string; order: number; op: string; players: { player_id: string; before: number; after: number }[] };
    expect(rt.kind).toBe("roll_pair_transform");
    expect(rt.order).toBe(5);
    expect(rt.op).toBe("swap");
    expect(rt.players).toHaveLength(2);
    const byId = Object.fromEntries(rt.players.map((p) => [p.player_id, p]));
    expect(byId[p1.googleSub]).toMatchObject({ before: 18, after: 4 });
    expect(byId[p2.googleSub]).toMatchObject({ before: 4, after: 18 });

    const out = await resolve(p1.client, roundId);
    const steps = pairSteps(out.trace);
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s.op).toBe("swap");
      expect(s.before.type).toBe("roll");
      expect(s.after.type).toBe("roll");
    }
    // p1 now holds 4 (the round's lowest) -> brews on lowest roll.
    expect(out.outcome).toBe("brewer");
    expect(out.brewer_id).toBe(p1.googleSub);
  });

  it("set-both-lower (min) drops both of the pair to the lower of the two rolls", async () => {
    const p1 = await signUp("cp-min-1");
    const p2 = await signUp("cp-min-2");
    const p3 = await signUp("cp-min-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 17);
    await seedRoll(roundId, p3.googleSub, 14);
    const win = await openWindow(roundId);
    const castId = await seedPairCast(roundId, p1.googleSub, "min", [p1.googleSub, p2.googleSub], win, p2.googleSub);

    await applyPair(p1.client, roundId);

    const rolls = await rollsById(roundId);
    expect(rolls[p1.googleSub]).toBe(10);
    expect(rolls[p2.googleSub]).toBe(10);
    expect(rolls[p3.googleSub]).toBe(14);

    const rt = (await castInputs(castId)).roll_transform as { op: string; players: { player_id: string; before: number; after: number }[] };
    expect(rt.op).toBe("min");
    const byId = Object.fromEntries(rt.players.map((p) => [p.player_id, p]));
    expect(byId[p1.googleSub]).toMatchObject({ before: 10, after: 10 });
    expect(byId[p2.googleSub]).toMatchObject({ before: 17, after: 10 });

    const out = await resolve(p1.client, roundId);
    // a step per affected player even when one is unchanged (spec section 3)
    expect(pairSteps(out.trace)).toHaveLength(2);
  });

  it("set-both-higher (max) lifts both of the pair to the higher of the two rolls", async () => {
    const p1 = await signUp("cp-max-1");
    const p2 = await signUp("cp-max-2");
    const p3 = await signUp("cp-max-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 6);
    await seedRoll(roundId, p2.googleSub, 19);
    await seedRoll(roundId, p3.googleSub, 5);
    const win = await openWindow(roundId);
    const castId = await seedPairCast(roundId, p1.googleSub, "max", [p1.googleSub, p2.googleSub], win, p2.googleSub);

    await applyPair(p1.client, roundId);

    const rolls = await rollsById(roundId);
    expect(rolls[p1.googleSub]).toBe(19);
    expect(rolls[p2.googleSub]).toBe(19);
    expect(rolls[p3.googleSub]).toBe(5);

    const rt = (await castInputs(castId)).roll_transform as { op: string; players: { player_id: string; before: number; after: number }[] };
    expect(rt.op).toBe("max");

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p3.googleSub); // p3's untouched 5 is now the table low
    expect(pairSteps(out.trace)).toHaveLength(2);
  });

  it("a no-op transform (pair already equal) still records and traces a step per player", async () => {
    const p1 = await signUp("cp-noop-1");
    const p2 = await signUp("cp-noop-2");
    const p3 = await signUp("cp-noop-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 12);
    await seedRoll(roundId, p2.googleSub, 12);
    await seedRoll(roundId, p3.googleSub, 3);
    const win = await openWindow(roundId);
    const castId = await seedPairCast(roundId, p1.googleSub, "swap", [p1.googleSub, p2.googleSub], win, p2.googleSub);

    await applyPair(p1.client, roundId);

    const rt = (await castInputs(castId)).roll_transform as { players: { before: number; after: number }[] };
    expect(rt.players.every((p) => p.before === p.after)).toBe(true);

    const out = await resolve(p1.client, roundId);
    expect(pairSteps(out.trace)).toHaveLength(2);
  });

  // ----------------------------------------------------------------------
  // Roll-domain ward on either named player cancels the whole transform
  // ----------------------------------------------------------------------

  it("a roll-domain ward on the losing end of a swap cancels it with no mutation", async () => {
    const p1 = await signUp("cp-wardlose-1");
    const p2 = await signUp("cp-wardlose-2");
    const p3 = await signUp("cp-wardlose-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 18); // would LOSE value -> negative -> Cast-Iron Kettle catches it
    await seedRoll(roundId, p2.googleSub, 4);
    await seedRoll(roundId, p3.googleSub, 9);
    const win = await openWindow(roundId);
    const castId = await seedPairCast(roundId, p1.googleSub, "swap", [p1.googleSub, p2.googleSub], win, p2.googleSub);
    await seedWard(p1.roomId, p1.googleSub, p1.googleSub, { polarity: ["negative"], domain: ["roll"] });

    await applyPair(p1.client, roundId);

    const rolls = await rollsById(roundId);
    expect(rolls[p1.googleSub]).toBe(18);
    expect(rolls[p2.googleSub]).toBe(4);

    const rt = (await castInputs(castId)).roll_transform as { players: { warded?: boolean; before: number; after: number; would_be_after?: number }[] };
    expect(rt.players.every((p) => p.warded === true && p.before === p.after)).toBe(true);

    const out = await resolve(p1.client, roundId);
    expect(out.trace.some((s) => s.display_kind === "warded" && s.before.type === "roll")).toBe(true);
    expect(out.brewer_id).toBe(p2.googleSub); // p2 keeps 4 -> table low
  });

  it("a roll-domain ward on the GAINING end of a swap also cancels it (either end blocks)", async () => {
    const p1 = await signUp("cp-wardgain-1");
    const p2 = await signUp("cp-wardgain-2");
    const p3 = await signUp("cp-wardgain-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 2); // pair[0]: swaps 2 -> 16, GAINS -> positive
    await seedRoll(roundId, p2.googleSub, 16);
    await seedRoll(roundId, p3.googleSub, 9);
    const win = await openWindow(roundId);
    await seedPairCast(roundId, p1.googleSub, "swap", [p1.googleSub, p2.googleSub], win, p2.googleSub);
    // Positive-polarity roll ward on the GAINING end (p1) — Jinxed Biscuit.
    await seedWard(p1.roomId, p1.googleSub, p1.googleSub, { polarity: ["positive"], domain: ["roll"] }, "Jinxed Biscuit");

    await applyPair(p1.client, roundId);

    const rolls = await rollsById(roundId);
    expect(rolls[p1.googleSub]).toBe(2);
    expect(rolls[p2.googleSub]).toBe(16);

    const out = await resolve(p1.client, roundId);
    expect(out.trace.some((s) => s.display_kind === "warded")).toBe(true);
  });

  // ----------------------------------------------------------------------
  // The by-name cast branches: Brew-tal Swap (Reaction)
  // ----------------------------------------------------------------------

  it("Brew-tal Swap (Reaction) emits a swap roll_pair_transform cast over caster + target", async () => {
    const p1 = await signUp("cp-bts-1");
    const p2 = await signUp("cp-bts-2");
    const p3 = await signUp("cp-bts-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 15);
    await seedRoll(roundId, p2.googleSub, 6);
    await seedRoll(roundId, p3.googleSub, 8);
    await openWindow(roundId, "open");

    await forceHold(admin, p1.googleSub, "Brew-tal Swap");
    const { data: castId, error } = await p1.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p2.googleSub,
    });
    expect(error).toBeNull();

    const { data: row } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, cast_inputs, caster_id, target_player_id")
      .eq("id", castId as string)
      .single();
    expect(row!.effect_kind).toBe("roll_pair_transform");
    expect((row!.effect_params as { op: string }).op).toBe("swap");
    expect((row!.cast_inputs as { pair: string[] }).pair).toEqual([p1.googleSub, p2.googleSub]);

    await applyPair(p1.client, roundId);
    const rolls = await rollsById(roundId);
    expect(rolls[p1.googleSub]).toBe(6);
    expect(rolls[p2.googleSub]).toBe(15);
  });

  it("Brew-tal Swap cannot target yourself", async () => {
    const p1 = await signUp("cp-btsself-1");
    const p2 = await signUp("cp-btsself-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await openWindow(roundId, "open");
    await forceHold(admin, p1.googleSub, "Brew-tal Swap");
    const { error } = await p1.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p1.googleSub,
    });
    expect(error).not.toBeNull();
  });

  // ----------------------------------------------------------------------
  // The by-name cast branches: Stir the Pot / Steaming Mug Bond / Tea for Two
  // ----------------------------------------------------------------------

  it("Stir the Pot (Action) swaps two OTHER players and attaches to the layer-0 window", async () => {
    const p1 = await signUp("cp-stp-1");
    const p2 = await signUp("cp-stp-2");
    const p3 = await signUp("cp-stp-3");
    const roundId = await startRound(p1, [p2, p3]);

    await forceHold(admin, p1.googleSub, "Stir the Pot");
    const { data: castId, error } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [p2.googleSub, p3.googleSub],
    });
    expect(error).toBeNull();

    const { data: row } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, cast_inputs, target_player_id, reaction_window_id")
      .eq("id", castId as string)
      .single();
    expect(row!.effect_kind).toBe("roll_pair_transform");
    expect((row!.effect_params as { op: string }).op).toBe("swap");
    expect((row!.cast_inputs as { pair: string[] }).pair).toEqual([p2.googleSub, p3.googleSub]);
    expect(row!.target_player_id).toBeNull();
    expect(row!.reaction_window_id).toBeNull();

    await closeRound(p1, roundId);
    await seedRoll(roundId, p1.googleSub, 12);
    await seedRoll(roundId, p2.googleSub, 19);
    await seedRoll(roundId, p3.googleSub, 3);

    // open_reaction_window runs attach_pre_roll_roll_pair_transform_casts
    const { error: owErr } = await p1.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });
    expect(owErr).toBeNull();
    const { data: attached } = await admin
      .from("spell_casts")
      .select("reaction_window_id")
      .eq("id", castId as string)
      .single();
    expect(attached!.reaction_window_id).not.toBeNull();

    await applyPair(p1.client, roundId);
    const rolls = await rollsById(roundId);
    expect(rolls[p2.googleSub]).toBe(3);
    expect(rolls[p3.googleSub]).toBe(19);
    expect(rolls[p1.googleSub]).toBe(12);

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p2.googleSub); // p2 now holds the swapped-in 3
  });

  it("Stir the Pot rejects choosing the caster, and rejects not-exactly-two", async () => {
    const p1 = await signUp("cp-stpbad-1");
    const p2 = await signUp("cp-stpbad-2");
    const p3 = await signUp("cp-stpbad-3");
    const roundId = await startRound(p1, [p2, p3]);

    await forceHold(admin, p1.googleSub, "Stir the Pot");
    const includesCaster = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [p1.googleSub, p2.googleSub],
    });
    expect(includesCaster.error?.code).toBe("RFB46");

    const onlyOne = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [p2.googleSub],
    });
    expect(onlyOne.error?.code).toBe("RFB46");
  });

  it("Steaming Mug Bond (Action, min) links caster + target and needs an explicit target", async () => {
    const p1 = await signUp("cp-smb-1");
    const p2 = await signUp("cp-smb-2");
    const p3 = await signUp("cp-smb-3");
    const roundId = await startRound(p1, [p2, p3]);

    await forceHold(admin, p1.googleSub, "Steaming Mug Bond");
    const noTarget = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(noTarget.error?.code).toBe("RFB46");

    await forceHold(admin, p1.googleSub, "Steaming Mug Bond");
    const { data: castId, error } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p2.googleSub,
    });
    expect(error).toBeNull();
    const { data: row } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, cast_inputs")
      .eq("id", castId as string)
      .single();
    expect(row!.effect_kind).toBe("roll_pair_transform");
    expect((row!.effect_params as { op: string }).op).toBe("min");
    expect((row!.cast_inputs as { pair: string[] }).pair).toEqual([p1.googleSub, p2.googleSub]);

    await closeRound(p1, roundId);
    await seedRoll(roundId, p1.googleSub, 13);
    await seedRoll(roundId, p2.googleSub, 18);
    await seedRoll(roundId, p3.googleSub, 4);
    await p1.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });
    await applyPair(p1.client, roundId);

    const rolls = await rollsById(roundId);
    expect(rolls[p1.googleSub]).toBe(13);
    expect(rolls[p2.googleSub]).toBe(13);
  });

  it("Tea for Two (Action, max) lifts caster + target to the higher of the two rolls", async () => {
    const p1 = await signUp("cp-tft-1");
    const p2 = await signUp("cp-tft-2");
    const p3 = await signUp("cp-tft-3");
    const roundId = await startRound(p1, [p2, p3]);

    await forceHold(admin, p1.googleSub, "Tea for Two");
    const { data: castId, error } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p2.googleSub,
    });
    expect(error).toBeNull();
    const { data: row } = await admin
      .from("spell_casts")
      .select("effect_params, cast_inputs")
      .eq("id", castId as string)
      .single();
    expect((row!.effect_params as { op: string }).op).toBe("max");
    expect((row!.cast_inputs as { pair: string[] }).pair).toEqual([p1.googleSub, p2.googleSub]);

    await closeRound(p1, roundId);
    await seedRoll(roundId, p1.googleSub, 7);
    await seedRoll(roundId, p2.googleSub, 16);
    await seedRoll(roundId, p3.googleSub, 20);
    await p1.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });
    await applyPair(p1.client, roundId);

    const rolls = await rollsById(roundId);
    expect(rolls[p1.googleSub]).toBe(16);
    expect(rolls[p2.googleSub]).toBe(16);

    const out = await resolve(p1.client, roundId);
    expect(pairSteps(out.trace)).toHaveLength(2);
  });
});
