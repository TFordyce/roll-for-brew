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
    await admin.from("rounds").update({ resolution_summary: null }).eq("id", roundId);
    const recap = await getRoundRecap(resolveWith, roundId);
    const model = buildRoundRecap({ data: recap!, displayName: label });
    const caster = model.rows.find((r) => label(r.playerId) === "caster")!;
    expect(caster).toMatchObject({ roll: 10, snapshot: 0, total: null, badgeValue: null, degraded: true });
    expect(caster.terms.map((t) => t.cardName)).toEqual(["Lucky Sip"]);
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
