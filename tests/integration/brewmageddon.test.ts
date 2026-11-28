import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
  closeRoundAs,
  declareInAs,
  startRoundAs,
} from "./setup";

// Runs against a real Supabase stack. Issue #440 (spec #401, design #385):
// Brewmageddon compels every participant holding a card at close_round to
// play it this round. Action holders cast in a Compelled Cast step that holds
// all rolling; Reaction holders must cast in the Layer-0 Reaction Window and
// cannot pass it. An unmet obligation is Forfeited: the card goes back to the
// deck and a no-effect `forfeit` Cast Log row points at Brewmageddon.
describe.skipIf(!hasAnonTestEnv)("Brewmageddon: Compelled Cast and Forfeit (issue #440)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  type Player = Awaited<ReturnType<typeof signUpSignInAndEnterRoom>>;

  /** Signs up the players into their own room so no stranger joins the round. */
  async function players<const L extends readonly string[]>(...labels: L): Promise<{ [K in keyof L]: Player }> {
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `bm-${l}`)));
    const roomId = await seedDedicatedRoom(
      admin,
      cleanup,
      ps.map((p) => p.googleSub),
    );
    return ps.map((p) => ({ ...p, roomId })) as { [K in keyof L]: Player };
  }

  /** start_round in the players' room, and everyone else declares in. */
  async function openRound(starter: Player, others: Player[]): Promise<string> {
    const { data: roundId, error } = await startRoundAs(starter.client, starter.roomId);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await declareInAs(o.client, roundId);
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function castBrewmageddon(caster: Player, roundId: string): Promise<string> {
    await forceHold(admin, caster.googleSub, "Brewmageddon");
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  async function close(starter: Player, roundId: string) {
    const { error } = await closeRoundAs(roundId);
    expect(error).toBeNull();
  }

  async function castRows(roundId: string) {
    const { data, error } = await admin
      .from("spell_casts")
      .select("id, caster_id, effect_kind, target_player_id, cast_inputs, card_instance_id")
      .eq("round_id", roundId)
      .order("seq");
    if (error) throw error;
    return data as {
      id: string;
      caster_id: string;
      effect_kind: string | null;
      target_player_id: string | null;
      cast_inputs: Record<string, unknown> | null;
      card_instance_id: string;
    }[];
  }

  async function forfeits(roundId: string) {
    return (await castRows(roundId))
      .filter((c) => c.effect_kind === "forfeit")
      .map((c) => ({ player: c.caster_id, reason: c.cast_inputs?.reason, compelledBy: c.cast_inputs?.compelled_by }));
  }

  async function heldBy(playerId: string): Promise<string[]> {
    const { data, error } = await admin
      .from("spell_deck_instances")
      .select("location")
      .eq("held_by_player", playerId);
    if (error) throw error;
    return (data as { location: string }[]).map((r) => r.location);
  }

  async function step(p: Player, roundId: string) {
    const { data, error } = await p.client.rpc("get_compelled_cast_step", { p_round_id: roundId });
    expect(error).toBeNull();
    return (data as { waiting_on: string[]; ended_at: string | null }[])[0]!;
  }

  // ------------------------------------------------------------------------
  // Compelled Cast step (Action cards)
  // ------------------------------------------------------------------------

  it("keeps the Compelled Cast step open until every compelled Action cast is in", async () => {
    const [caster, holder, bystander] = await players("step-caster", "step-holder", "step-bystander");
    await forceHold(admin, holder.googleSub, "Sugar Rush"); // Action / SELF advantage
    const roundId = await openRound(caster, [holder, bystander]);
    const bmCastId = await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    expect((await step(bystander, roundId)).waiting_on).toEqual([holder.googleSub]);

    // The compelled cast is accepted while the round is closed.
    const { error: castErr } = await holder.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const adv = (await castRows(roundId)).find((c) => c.effect_kind === "advantage")!;
    expect(adv.cast_inputs?.compelled_by).toBe(bmCastId);
    expect(await heldBy(holder.googleSub)).toEqual([]);

    const s = await step(bystander, roundId);
    expect(s.waiting_on).toEqual([]);
    expect(s.ended_at).not.toBeNull();
  });

  it("refuses a compelled cast with a deferred target, and accepts one naming its target now", async () => {
    const [caster, holder] = await players("defer-caster", "defer-holder");
    await forceHold(admin, holder.googleSub, "Fortune's Flavour"); // Action / PLAYER advantage
    const roundId = await openRound(caster, [holder]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    const { error: deferErr } = await holder.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(deferErr?.code).toBe("RFB55");
    expect(await heldBy(holder.googleSub)).toEqual(["held"]);

    const { error } = await holder.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: holder.googleSub,
    });
    expect(error).toBeNull();
    expect((await step(caster, roundId)).waiting_on).toEqual([]);
  });

  it("a player who owes nothing still cannot cast while the round is closed", async () => {
    const [caster, holder, late] = await players("owe-caster", "owe-holder", "owe-late");
    await forceHold(admin, holder.googleSub, "Sugar Rush");
    const roundId = await openRound(caster, [holder]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    // Declared in after close: not in the compelled set, so no closed-round cast.
    const { error: lateErr } = await declareInAs(late.client, roundId);
    expect(lateErr).toBeNull();
    await forceHold(admin, late.googleSub, "Lucky Sip");
    const { error } = await late.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error?.code).toBe("RFB03");
  });

  // ------------------------------------------------------------------------
  // Forfeit triggers
  // ------------------------------------------------------------------------

  it("forfeits a compelled Action card with no legal target when the set is fixed", async () => {
    // Two participants: Stir the Pot needs two OTHER players; Greater Detox
    // (a third player's) needs an active effect to end -- there is none.
    const [caster, stirrer, detoxer] = await players("nlt-caster", "nlt-stirrer", "nlt-detoxer");
    await forceHold(admin, stirrer.googleSub, "Stir the Pot");
    await forceHold(admin, detoxer.googleSub, "Greater Detox");
    const roundId = await openRound(caster, [stirrer, detoxer]);
    const bmCastId = await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    // Three participants: Stir the Pot has exactly two others, so it is legal.
    expect(await forfeits(roundId)).toEqual([
      { player: detoxer.googleSub, reason: "no_legal_target", compelledBy: bmCastId },
    ]);
    expect(await heldBy(detoxer.googleSub)).toEqual([]);
    expect((await step(caster, roundId)).waiting_on).toEqual([stirrer.googleSub]);
  });

  it("forfeits Stir the Pot in a two-player round, and the Compelled Cast step ends at once", async () => {
    const [caster, stirrer] = await players("nlt2-caster", "nlt2-stirrer");
    await forceHold(admin, stirrer.googleSub, "Stir the Pot");
    const roundId = await openRound(caster, [stirrer]);
    await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    expect((await forfeits(roundId)).map((f) => f.reason)).toEqual(["no_legal_target"]);
    const s = await step(stirrer, roundId);
    expect(s.waiting_on).toEqual([]);
    expect(s.ended_at).not.toBeNull();
  });

  it("forfeits Tea Heist only when no other participant holds a card to steal (#438)", async () => {
    const [caster, thief, bystander] = await players("heist-caster", "heist-thief", "heist-bystander");
    await forceHold(admin, thief.googleSub, "Tea Heist");
    const roundId = await openRound(caster, [thief, bystander]);
    const bmCastId = await castBrewmageddon(caster, roundId);
    await close(caster, roundId);

    expect(await forfeits(roundId)).toEqual([
      { player: thief.googleSub, reason: "no_legal_target", compelledBy: bmCastId },
    ]);

    const [caster2, thief2, victim] = await players("heist2-caster", "heist2-thief", "heist2-victim");
    await forceHold(admin, thief2.googleSub, "Tea Heist");
    await forceHold(admin, victim.googleSub, "Sugar Rush");
    const roundId2 = await openRound(caster2, [thief2, victim]);
    await castBrewmageddon(caster2, roundId2);
    await close(caster2, roundId2);

    expect(await forfeits(roundId2)).toEqual([]);
    expect((await step(caster2, roundId2)).waiting_on.sort()).toEqual([thief2.googleSub, victim.googleSub].sort());
  });
});
