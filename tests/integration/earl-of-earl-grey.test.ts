import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #429 (spec #401, design #381):
// Earl of Earl Grey -- "Take the title of Earl. While Earl, you cannot be
// tea-maker -- the next-lowest roller makes tea instead. If a card would force
// tea on you, pass the title to its caster: they become Earl, you lose
// immunity."
//
//   * The title is a `brewer_immunity` row, mode `earl`, unbounded (`persist`),
//     dispellable. There is only ever one Earl: the newest live title row in
//     the room is the Earl, and the round that resolves ends the others
//     (spell_active_effects.ended_in_round_id).
//   * Any tea_maker_override naming the Earl first passes the title to the
//     override's caster, then lands on the ex-Earl, who brews. A declared
//     number matching the Earl is a plain immunity skip -- no transfer.
//   * The resolver only decides the transfer; finalize_layer writes it, so a
//     Provisional Recap's dry run never moves the title (ADR 0007).
// Assertions are on observable outcomes: the picked brewer, the Resolution
// Trace and who holds a live title row afterwards.

type TraceStep = {
  index: number;
  display_kind: string;
  source_cast: {
    cast_id: string | null;
    active_effect_id: string | null;
    card_name: string | null;
    caster_player_id: string | null;
  };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  immunity_tier?: string;
  skipped_card_name?: string | null;
  new_earl_player_id?: string;
  forcing_card_name?: string | null;
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  layer: number;
  brewer_id: string | null;
  brewer_source: string | null;
  tied_player_ids: string[] | null;
  earl_transfer: { active_effect_id: string; from_player_id: string; to_player_id: string; cast_id: string } | null;
  trace: TraceStep[];
};

const EARL = "Earl of Earl Grey";

describe.skipIf(!hasAnonTestEnv)("Earl of Earl Grey (#429)", () => {
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
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `earl-${l}`)));
    const roomId = await seedDedicatedRoom(
      admin,
      cleanup,
      ps.map((p) => p.googleSub),
    );
    return ps.map((p) => ({ ...p, roomId })) as { [K in keyof L]: Player };
  }

  async function openRound(starter: Player, others: Player[]): Promise<string> {
    const { data: roundId, error } = await starter.client.rpc("start_round", { p_room_id: starter.roomId });
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function close(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function openAndCloseRound(starter: Player, others: Player[]) {
    const roundId = await openRound(starter, others);
    await close(starter, roundId);
    return roundId;
  }

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

  async function rollAll(roundId: string, rolls: [Player, number, number?][]) {
    for (const [p, v, m] of rolls) await seedRoll(roundId, p.googleSub, v, m ?? 0);
  }

  /** A Cast Log row recorded straight into the table, donor instance returned to the deck. */
  async function seedCast(
    roundId: string,
    caster: Player,
    donorCard: string,
    row: { effectKind: string; effectParams?: Record<string, unknown>; targetPlayerId?: string | null },
  ) {
    const instanceId = await forceHold(admin, caster.googleSub, donorCard);
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: caster.googleSub,
        card_instance_id: instanceId,
        target_player_id: row.targetPlayerId ?? null,
        target_pending: false,
        effect_kind: row.effectKind,
        effect_params: row.effectParams ?? {},
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** A Drip Tray-donor `chosen` override from `caster` naming `target`. */
  function forceTea(roundId: string, caster: Player, target: Player, mode = "chosen") {
    return seedCast(roundId, caster, "Drip Tray", {
      effectKind: "tea_maker_override",
      effectParams: { mode },
      targetPlayerId: mode === "chosen" ? target.googleSub : null,
    });
  }

  /** Earl of Earl Grey, cast for real through cast_spell_card while `roundId` is open. */
  async function castEarl(caster: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, EARL);
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  /** A live Earl title on `holder`, projected from an earlier (resolved) round. */
  async function seedEarl(holder: Player) {
    return seedActiveEffect(admin, cleanup, {
      roomId: holder.roomId,
      targetPlayerId: holder.googleSub,
      casterId: holder.googleSub,
      cardName: EARL,
      effectKind: "brewer_immunity",
      effectParams: { mode: "earl", persist: true },
      roundsRemaining: null,
    });
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  async function finalize(client: SupabaseClient, roundId: string) {
    const { error: wErr } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" });
    expect(wErr).toBeNull();
    const { data, error } = await client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { outcome: string; brewer_id?: string; replay_pending?: boolean };
  }

  /** The players holding an Earl title row that is live as of `roundId`. */
  async function earlsAsOf(roomId: string, roundId: string): Promise<string[]> {
    const { data, error } = await admin.rpc("_rr_active_effects_as_of", {
      p_room_id: roomId,
      p_as_of_round_id: roundId,
    });
    expect(error).toBeNull();
    return (data as { effect_kind: string; target_player_id: string; effect_params: { mode?: string } }[])
      .filter((r) => r.effect_kind === "brewer_immunity" && r.effect_params.mode === "earl")
      .map((r) => r.target_player_id);
  }

  /** Every Earl title row in the room, live or ended. */
  async function titleRows(roomId: string) {
    const { data, error } = await admin
      .from("spell_active_effects")
      .select("id, target_player_id, caster_id, ended_in_round_id, rounds_remaining, is_undispellable, effect_params")
      .eq("room_id", roomId)
      .eq("effect_kind", "brewer_immunity")
      .order("created_at");
    expect(error).toBeNull();
    return data!;
  }

  const steps = (out: ResolveOutcome, kind: string) => out.trace.filter((s) => s.display_kind === kind);

  // -----------------------------------------------------------------------
  // The card.
  // -----------------------------------------------------------------------

  it("is un-benched and casting it promotes an unbounded, dispellable `earl` row", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", EARL)
      .single();
    expect(inst!.location).not.toBe("benched");

    const [caster, other] = await players("cast-a", "cast-b");
    const roundId = await openRound(caster, [other]);
    await castEarl(caster, roundId);

    const rows = await titleRows(caster.roomId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_player_id: caster.googleSub,
      rounds_remaining: null,
      is_undispellable: false,
      ended_in_round_id: null,
      effect_params: { mode: "earl" },
    });
  });

  // -----------------------------------------------------------------------
  // While Earl: the next-lowest roller brews.
  // -----------------------------------------------------------------------

  it("the Earl would be lowest: the next-lowest roller brews, end to end", async () => {
    const [earl, mid, high] = await players("low-a", "low-b", "low-c");
    const roundId = await openRound(earl, [mid, high]);
    await castEarl(earl, roundId);
    await close(earl, roundId);
    await rollAll(roundId, [[earl, 2], [mid, 9], [high, 15]]);

    const out = await resolve(earl.client, roundId);
    expect(out).toMatchObject({ outcome: "brewer", brewer_id: mid.googleSub, brewer_source: "default", earl_transfer: null });
    expect(steps(out, "brewer_immunity")).toEqual([
      expect.objectContaining({
        target_player: earl.googleSub,
        immunity_tier: "lowest_roller",
        source_cast: expect.objectContaining({ card_name: EARL }),
      }),
    ]);

    expect(await finalize(earl.client, roundId)).toMatchObject({ outcome: "brewer", brewer_id: mid.googleSub });
    expect(await earlsAsOf(earl.roomId, roundId)).toEqual([earl.googleSub]);
  });

  // -----------------------------------------------------------------------
  // Only ever one Earl.
  // -----------------------------------------------------------------------

  it("casting Earl while someone else holds the title leaves exactly one Earl", async () => {
    const [oldEarl, newEarl, other] = await players("one-a", "one-b", "one-c");
    await seedEarl(oldEarl);

    const r1 = await openRound(oldEarl, [newEarl, other]);
    await castEarl(newEarl, r1);
    await close(oldEarl, r1);
    // The old Earl rolls lowest: they lost the title the moment it was taken.
    await rollAll(r1, [[oldEarl, 1], [newEarl, 3], [other, 18]]);
    expect(await earlsAsOf(oldEarl.roomId, r1)).toEqual([newEarl.googleSub]);

    const out = await resolve(oldEarl.client, r1);
    expect(out.brewer_id).toBe(oldEarl.googleSub);
    expect(steps(out, "brewer_immunity")).toHaveLength(0);

    await finalize(oldEarl.client, r1);
    const rows = await titleRows(oldEarl.roomId);
    expect(rows.filter((r) => r.ended_in_round_id === null).map((r) => r.target_player_id)).toEqual([newEarl.googleSub]);
    expect(rows.find((r) => r.target_player_id === oldEarl.googleSub)!.ended_in_round_id).toBe(r1);

    // Next round: the new Earl is immune, the old one isn't.
    const r2 = await openAndCloseRound(oldEarl, [newEarl, other]);
    await rollAll(r2, [[newEarl, 1], [oldEarl, 5], [other, 18]]);
    expect(await earlsAsOf(oldEarl.roomId, r2)).toEqual([newEarl.googleSub]);
    expect((await resolve(oldEarl.client, r2)).brewer_id).toBe(oldEarl.googleSub);
  });

  it("dispelling the new Earl does not hand the title back to the old one", async () => {
    const [oldEarl, newEarl, other] = await players("disp-a", "disp-b", "disp-c");
    await seedEarl(oldEarl);
    const r1 = await openRound(oldEarl, [newEarl, other]);
    await castEarl(newEarl, r1);
    await close(oldEarl, r1);
    await rollAll(r1, [[oldEarl, 4], [newEarl, 12], [other, 2]]);
    await finalize(oldEarl.client, r1);

    const newRow = (await titleRows(oldEarl.roomId)).find((r) => r.target_player_id === newEarl.googleSub)!;
    const r2 = await openRound(oldEarl, [newEarl, other]);
    await seedCast(r2, other, "Greater Detox", {
      effectKind: "dispel",
      effectParams: { ended_effect_id: newRow.id },
      targetPlayerId: newEarl.googleSub,
    });
    await close(oldEarl, r2);
    expect(await earlsAsOf(oldEarl.roomId, r2)).toEqual([]);
  });

  it("a countered Earl cast takes nothing from the sitting Earl", async () => {
    const [oldEarl, caster, other] = await players("neg-a", "neg-b", "neg-c");
    await seedEarl(oldEarl);
    const r1 = await openRound(oldEarl, [caster, other]);
    const castId = await castEarl(caster, r1);
    await close(oldEarl, r1);
    await admin.from("spell_casts").update({ negated: true }).eq("id", castId);
    await rollAll(r1, [[oldEarl, 1], [caster, 3], [other, 18]]);

    const out = await resolve(oldEarl.client, r1);
    expect(out.brewer_id).toBe(caster.googleSub);
    await finalize(oldEarl.client, r1);
    const r2 = await openRound(oldEarl, [caster, other]);
    expect(await earlsAsOf(oldEarl.roomId, r2)).toEqual([oldEarl.googleSub]);
  });

  // -----------------------------------------------------------------------
  // A force on the Earl: the title transfers, the ex-Earl brews.
  // -----------------------------------------------------------------------

  it.each(["chosen", "highest_roll"])(
    "a %s override naming the Earl moves the title to its caster, and the ex-Earl brews",
    async (mode) => {
      const [earl, caster, other] = await players(`xfer-${mode}-a`, `xfer-${mode}-b`, `xfer-${mode}-c`);
      const { effectId } = await seedEarl(earl);
      const r1 = await openAndCloseRound(earl, [caster, other]);
      // The Earl has the highest roll, so highest_roll names them too.
      await rollAll(r1, [[earl, 19], [caster, 11], [other, 4]]);
      const castId = await forceTea(r1, caster, earl, mode);

      const out = await resolve(caster.client, r1);
      expect(out).toMatchObject({
        outcome: "brewer",
        brewer_id: earl.googleSub,
        brewer_source: `tea_maker_override:${mode}`,
        earl_transfer: {
          active_effect_id: effectId,
          from_player_id: earl.googleSub,
          to_player_id: caster.googleSub,
          cast_id: castId,
        },
      });
      expect(steps(out, "brewer_immunity")).toHaveLength(0);
      const [xfer] = steps(out, "earl_transfer");
      expect(xfer).toMatchObject({
        target_player: earl.googleSub,
        source_cast: { active_effect_id: effectId, card_name: EARL, caster_player_id: earl.googleSub },
        before: { type: "status", value: "earl" },
        after: { type: "status", value: "title passed" },
        new_earl_player_id: caster.googleSub,
        forcing_card_name: "Drip Tray",
      });
      // The transfer comes first, then the override lands.
      const override = steps(out, "tea_maker_override")[0]!;
      expect(xfer!.index).toBeLessThan(override.index);
      expect(override).toMatchObject({ target_player: earl.googleSub, after: { value: "brewer" } });

      // resolve_round alone persists only the Trace; the title moves on commit.
      expect(await earlsAsOf(earl.roomId, r1)).toEqual([earl.googleSub]);
      expect(await finalize(caster.client, r1)).toMatchObject({ outcome: "brewer", brewer_id: earl.googleSub });

      const rows = await titleRows(earl.roomId);
      expect(rows.filter((r) => r.ended_in_round_id === null)).toEqual([
        expect.objectContaining({
          target_player_id: caster.googleSub,
          caster_id: caster.googleSub,
          rounds_remaining: null,
          effect_params: expect.objectContaining({ mode: "earl", transferred_from_effect_id: effectId }),
        }),
      ]);

      // Next round: the new Earl is passed over, the ex-Earl isn't.
      const r2 = await openAndCloseRound(earl, [caster, other]);
      await rollAll(r2, [[caster, 1], [earl, 6], [other, 17]]);
      const next = await resolve(earl.client, r2);
      expect(next.brewer_id).toBe(earl.googleSub);
      expect(steps(next, "brewer_immunity").map((s) => s.target_player)).toEqual([caster.googleSub]);
    },
  );

  it("an override on someone else leaves the title where it is", async () => {
    const [earl, caster, other] = await players("else-a", "else-b", "else-c");
    await seedEarl(earl);
    const r1 = await openAndCloseRound(earl, [caster, other]);
    await rollAll(r1, [[earl, 2], [caster, 11], [other, 14]]);
    await forceTea(r1, caster, other);

    const out = await resolve(caster.client, r1);
    expect(out).toMatchObject({ brewer_id: other.googleSub, earl_transfer: null });
    await finalize(caster.client, r1);
    expect((await titleRows(earl.roomId)).filter((r) => r.ended_in_round_id === null).map((r) => r.target_player_id))
      .toEqual([earl.googleSub]);
  });

  it("an Earl who also holds override-proof immunity is simply passed over: no transfer", async () => {
    const [earl, caster, other] = await players("proof-a", "proof-b", "proof-c");
    await seedEarl(earl);
    await seedActiveEffect(admin, cleanup, {
      roomId: earl.roomId,
      targetPlayerId: earl.googleSub,
      casterId: earl.googleSub,
      cardName: "The Last Cuppa",
      effectKind: "brewer_immunity",
      effectParams: { mode: "last_cuppa", persist: true, undispellable: true, override_proof: true },
    });
    const r1 = await openAndCloseRound(earl, [caster, other]);
    await rollAll(r1, [[earl, 19], [caster, 11], [other, 4]]);
    await forceTea(r1, caster, earl);

    const out = await resolve(caster.client, r1);
    expect(out).toMatchObject({ brewer_id: other.googleSub, brewer_source: "default", earl_transfer: null });
    expect(steps(out, "earl_transfer")).toHaveLength(0);
    expect(steps(out, "brewer_immunity")[0]).toMatchObject({ immunity_tier: "tea_maker_override" });
  });

  it("an override the Earl cast on themselves can't pass the title to its own holder: plain skip", async () => {
    const [earl, other] = await players("self-a", "self-b");
    await seedEarl(earl);
    const r1 = await openAndCloseRound(earl, [other]);
    await rollAll(r1, [[earl, 19], [other, 4]]);
    await forceTea(r1, earl, earl);

    const out = await resolve(earl.client, r1);
    expect(out).toMatchObject({ brewer_id: other.googleSub, earl_transfer: null });
    expect(steps(out, "brewer_immunity")[0]).toMatchObject({ target_player: earl.googleSub, immunity_tier: "tea_maker_override" });
  });

  // -----------------------------------------------------------------------
  // A declared number is not a force.
  // -----------------------------------------------------------------------

  it("a declared number matching the Earl is skipped (immune), with no transfer", async () => {
    const [earl, declarer, other] = await players("decl-a", "decl-b", "decl-c");
    await seedEarl(earl);
    const r1 = await openAndCloseRound(earl, [declarer, other]);
    await seedActiveEffect(admin, cleanup, {
      roomId: earl.roomId,
      targetPlayerId: declarer.googleSub,
      casterId: declarer.googleSub,
      cardName: "Inscribed Saucer",
      effectKind: "declared_number_tea_maker",
      effectParams: { number: 12 },
      roundsRemaining: 1,
      roundId: r1,
    });
    await rollAll(r1, [[earl, 12], [declarer, 8], [other, 15]]);

    const out = await resolve(earl.client, r1);
    expect(out).toMatchObject({ brewer_id: declarer.googleSub, brewer_source: "default", earl_transfer: null });
    expect(steps(out, "earl_transfer")).toHaveLength(0);
    expect(steps(out, "brewer_immunity")[0]).toMatchObject({ immunity_tier: "declared_number" });

    await finalize(earl.client, r1);
    expect((await titleRows(earl.roomId)).filter((r) => r.ended_in_round_id === null).map((r) => r.target_player_id))
      .toEqual([earl.googleSub]);
  });

  // -----------------------------------------------------------------------
  // The dry run never moves the title.
  // -----------------------------------------------------------------------

  it("viewing the Provisional Recap mid-window doesn't move the title", async () => {
    const [earl, caster, other] = await players("dry-a", "dry-b", "dry-c");
    await seedEarl(earl);
    const r1 = await openAndCloseRound(earl, [caster, other]);
    await rollAll(r1, [[earl, 19], [caster, 11], [other, 4]]);
    await forceTea(r1, caster, earl);
    const before = await titleRows(earl.roomId);

    // The dry-run resolver decides the transfer...
    const { data: dry, error: dryErr } = await admin.rpc("_rr_resolve", { p_round_id: r1 });
    expect(dryErr).toBeNull();
    expect((dry as ResolveOutcome).earl_transfer).toMatchObject({ to_player_id: caster.googleSub });

    // ...and the Provisional Recap a viewer loads runs it too.
    const { error: recapErr } = await other.client.rpc("get_round_recap", { p_round_id: r1 });
    expect(recapErr).toBeNull();

    expect(await titleRows(earl.roomId)).toEqual(before);
    expect(await earlsAsOf(earl.roomId, r1)).toEqual([earl.googleSub]);
  });

  // -----------------------------------------------------------------------
  // Round replay.
  // -----------------------------------------------------------------------

  it("a Round replay of the round that moved the title hands it back", async () => {
    const [earl, caster, other] = await players("rep-a", "rep-b", "rep-c");
    const { effectId } = await seedEarl(earl);
    const r1 = await openAndCloseRound(earl, [caster, other]);
    await rollAll(r1, [[earl, 19], [caster, 11], [other, 4]]);
    await forceTea(r1, caster, earl);
    await seedCast(r1, other, "Time for Brew", { effectKind: "round_replay" });

    const fin = await finalize(caster.client, r1);
    expect(fin).toMatchObject({ outcome: "brewer", brewer_id: earl.googleSub, replay_pending: true });
    expect((await titleRows(earl.roomId)).filter((r) => r.ended_in_round_id === null).map((r) => r.target_player_id))
      .toEqual([caster.googleSub]);

    const { error: confErr } = await other.client.rpc("confirm_round_replay", { p_round_id: r1 });
    expect(confErr).toBeNull();

    const rows = await titleRows(earl.roomId);
    expect(rows).toEqual([expect.objectContaining({ id: effectId, target_player_id: earl.googleSub, ended_in_round_id: null })]);
    expect(await earlsAsOf(earl.roomId, r1)).toEqual([earl.googleSub]);
  });
});
