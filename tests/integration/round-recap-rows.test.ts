// Issue #402 (spec) — the per-player roll row renders the resolver's own
// output (ADR 0007). Drives the real read path end to end: seed a corpus round,
// resolve it, read get_round_recap as a participant through getRoundRecap, and
// build the Round Recap module's row model — asserting on what that seam
// returns (rows, Reroll Chain), never on internal tables.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv } from "./setup";
import { CORPUS } from "../snapshots/corpus";
import { makeContext, type ScenarioContext } from "../snapshots/corpus/framework";
import { getRoundRecap } from "@/lib/supabase/roundRecap";
import { buildRerollChain, buildRoundRecap } from "@/lib/game/roundRecap";

function scenario(name: string) {
  const s = CORPUS.find((c) => c.name === name);
  if (!s) throw new Error(`no corpus scenario ${name}`);
  return s;
}

describe.skipIf(!hasAnonTestEnv)("issue #402 — roll rows from the resolver", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;
  let ctx: ScenarioContext;

  beforeAll(() => {
    admin = createTestAdminClient();
  });

  afterEach(() => cleanup.run());

  function fresh() {
    cleanup = createTestCleanup(admin);
    ctx = makeContext(admin, cleanup);
    return ctx;
  }

  const label = (id: string) => ctx.roster[id] ?? id;

  async function resolvedRows(name: string) {
    const { roundId, resolveWith } = await scenario(name).seed(fresh());
    const { error } = await resolveWith.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    const recap = await getRoundRecap(resolveWith, roundId);
    expect(recap).not.toBeNull();
    return { recap: recap!, model: buildRoundRecap({ data: recap!, displayName: label }), roundId, resolveWith };
  }

  it("#407: a resolved round's rows carry the stored Resolution Summary, provisional false", async () => {
    const { recap, model, roundId } = await resolvedRows("4c-lowest-gains-highest-modifier");
    const { data: round } = await admin.from("rounds").select("resolution_summary").eq("id", roundId).single();

    expect(recap.provisional).toBe(false);
    expect(model.rows).toHaveLength(3);
    for (const entry of round!.resolution_summary as { player_id: string; total: number; nat: string | null }[]) {
      const row = model.rows.find((r) => r.playerId === entry.player_id)!;
      expect(row.total).toBe(entry.total);
      expect(row.nat).toBe(entry.nat);
      expect(row.degraded).toBe(false);
    }
    // lowest-gains-highest: the lowest roller's row gains the high roller's +5
    const lowest = model.rows.find((r) => label(r.playerId) === "lowest")!;
    expect(lowest.composed).toBe(5);
    expect(lowest.terms.map((t) => [t.displayKind, t.delta])).toEqual([["lowest_gains_highest_modifier", 5]]);
  });

  it("#407: a warded flat modifier is a struck term and not in the total", async () => {
    const { model } = await resolvedRows("2-ward-blocks-modifier-cast");
    const warded = model.rows.find((r) => label(r.playerId) === "warded")!;
    expect(warded.total).toBe(5);
    expect(warded.terms.map((t) => [t.cardName, t.struck])).toEqual([["Lucky Sip", "warded"]]);
  });

  it("#407: a redirected cast strikes the original target and lands on the new one", async () => {
    const { model } = await resolvedRows("1-redirect-retargets-modifier-cast");
    const original = model.rows.find((r) => label(r.playerId) === "redirector")!;
    const landed = model.rows.find((r) => label(r.playerId) === "orig-target")!;
    expect(original.terms.map((t) => t.struck)).toEqual(["redirected"]);
    expect(original.total).toBe(8);
    expect(landed.total).toBe(108);
  });

  it("#407: a Calami-Tea-floored 1 is not a nat 1 on the row", async () => {
    const { model } = await resolvedRows("3-calami-tea-floored-natural-1");
    const floored = model.rows.find((r) => label(r.playerId) === "floored")!;
    expect(floored).toMatchObject({ roll: 1, nat: null, diceReduced: true, badgeValue: 1 });
  });

  it("#407: a round with no summary (resolved before it existed) renders the degraded row", async () => {
    const { roundId, resolveWith } = await resolvedRows("4a-flat-modifier-self-buff");
    // settle it as a resolved round, then drop its summary as if it predated them
    const casterId = Object.keys(ctx.roster).find((id) => label(id) === "caster")!;
    const { error } = await resolveWith.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: casterId,
      p_cups_made: 2,
    });
    expect(error).toBeNull();
    await admin.from("rounds").update({ resolution_summary: null }).eq("id", roundId);
    const recap = await getRoundRecap(resolveWith, roundId);
    const model = buildRoundRecap({ data: recap!, displayName: label });
    const caster = model.rows.find((r) => label(r.playerId) === "caster")!;
    expect(caster).toMatchObject({ roll: 10, snapshot: 0, total: null, badgeValue: null, degraded: true });
    expect(caster.terms.map((t) => t.cardName)).toEqual(["Lucky Sip"]);
  });

  it("#409: no Provisional Recap until layer 0 is complete, then a live dry run", async () => {
    const c = fresh();
    const p1 = await c.signUp("first");
    const p2 = await c.signUp("second");
    const roundId = await c.openAndCloseRound(p1, [p2]);
    await c.seedRoll(roundId, p1.googleSub, 9);

    const partial = (await getRoundRecap(p1.client, roundId))!;
    expect(partial.provisional).toBe(false);
    expect(partial.summary).toBeNull();
    expect(partial.trace).toEqual([]);

    await c.seedRoll(roundId, p2.googleSub, 14);
    const live = (await getRoundRecap(p1.client, roundId))!;
    expect(live.provisional).toBe(true);
    const model = buildRoundRecap({ data: live, displayName: label });
    expect(model.provisional).toBe(true);
    expect(model.rows.map((r) => [label(r.playerId), r.total, r.provisional])).toEqual([
      ["first", 9, true],
      ["second", 14, true],
    ]);

    // a cast lands: the next read reflects it
    await c.seedCast(roundId, p2.googleSub, "Lucky Sip", {
      effectKind: "flat_modifier",
      effectParams: { delta: 3 },
      targetPlayerId: p1.googleSub,
    });
    const afterCast = buildRoundRecap({ data: (await getRoundRecap(p1.client, roundId))!, displayName: label });
    expect(afterCast.rows.find((r) => label(r.playerId) === "first")!.total).toBe(12);
    // the Ledger shows the steps so far, from the dry-run Trace
    expect(afterCast.phases.flatMap((p) => p.steps).map((s) => s.pending)).toEqual([false]);

    // nothing was persisted by any of those reads
    const { data: round } = await admin
      .from("rounds")
      .select("resolution_trace, resolution_summary")
      .eq("id", roundId)
      .single();
    expect(round).toEqual({ resolution_trace: null, resolution_summary: null });
  });

  it("#409: an unrolled Pending Spell Die holds the Provisional Recap back until its value lands", async () => {
    const c = fresh();
    const p1 = await c.signUp("roller");
    const p2 = await c.signUp("dicer");
    const roundId = await c.openAndCloseRound(p1, [p2]);
    await c.seedRoll(roundId, p1.googleSub, 9);
    await c.seedRoll(roundId, p2.googleSub, 14);
    const { castId } = await c.seedCast(roundId, p2.googleSub, "Six Sugars", {
      effectKind: "dice_modifier",
      effectParams: { dice: "1d6", sign: 1 },
      targetPlayerId: p2.googleSub,
    });
    expect((await getRoundRecap(p1.client, roundId))!.provisional).toBe(false);

    await admin.from("spell_casts").update({ cast_inputs: { dice_roll: 4 } }).eq("id", castId);
    const live = buildRoundRecap({ data: (await getRoundRecap(p1.client, roundId))!, displayName: label });
    expect(live.provisional).toBe(true);
    expect(live.rows.find((r) => label(r.playerId) === "dicer")!.total).toBe(18);
  });

  it("#409: a spectator in the room (not in the round) reads the same Provisional Recap", async () => {
    const c = fresh();
    const p1 = await c.signUp("in-a");
    const p2 = await c.signUp("in-b");
    const watcher = await c.signUp("watcher");
    expect(watcher.roomId).toBe(p1.roomId);
    const roundId = await c.openAndCloseRound(p1, [p2]);
    await c.seedRoll(roundId, p1.googleSub, 9);
    await c.seedRoll(roundId, p2.googleSub, 14);

    const seen = await getRoundRecap(watcher.client, roundId);
    expect(seen?.provisional).toBe(true);
    expect(seen?.summary?.map((e) => label(e.playerId)).sort()).toEqual(["in-a", "in-b"]);
  });

  it("#406: a spell-made layer-0 tie shows in every tied player's Reroll Chain", async () => {
    const { roundId, resolveWith } = await scenario("4a-spell-modifier-creates-layer0-tie").seed(fresh());
    const { data: out, error } = await resolveWith.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    const tied = (out as { tied_player_ids: string[] }).tied_player_ids;
    expect(tied.map(label).sort()).toEqual(["level", "lifted"]);

    const { error: advErr } = await resolveWith.rpc("advance_round_layer", {
      p_round_id: roundId,
      p_tied_player_ids: tied,
    });
    expect(advErr).toBeNull();
    await ctx.seedRoll(roundId, tied[0]!, 4, 0, 1);
    await ctx.seedRoll(roundId, tied[1]!, 15, 0, 1);

    const recap = (await getRoundRecap(resolveWith, roundId))!;
    for (const id of tied) {
      expect(buildRerollChain(id, recap.layers, recap.layerParticipants)).toMatchObject([
        { layer: 1, tied: false },
      ]);
    }
    const high = Object.keys(ctx.roster).find((id) => label(id) === "high")!;
    expect(buildRerollChain(high, recap.layers, recap.layerParticipants)).toEqual([]);
  });
});
