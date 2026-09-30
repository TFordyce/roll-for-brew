import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Covers issue #441: deleting the
// round a drain was cast in, after the drain has ticked in a later round.
// A later round's Bitter Leech / Calami-Tea tick row carries source_cast_id ->
// the origin round's cast, so admin_delete_round used to fail with 23503
// (spell_casts_source_cast_id_fkey had no ON DELETE action). With ON DELETE
// SET NULL the delete goes through: the drain's active effect cascades away
// with its origin cast (so it stops ticking), while tick rows already written
// in undeleted rounds stay applied and just lose their provenance.

describe.skipIf(!hasAnonTestEnv)("admin_delete_round on a drain's origin round (issue #441)", () => {
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

  async function makeAdmin(playerId: string) {
    const { error } = await admin.from("players").update({ is_admin: true }).eq("id", playerId);
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

  /** Close, seed layer-0 rolls, resolve, and stamp the round resolved. */
  async function playRound(starter: Player, roundId: string, rolls: [Player, number][]) {
    const { error: closeErr } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(closeErr).toBeNull();
    for (const [p, value] of rolls) {
      const { error } = await admin.from("rolls").insert({
        round_id: roundId,
        player_id: p.googleSub,
        layer: 0,
        value,
        input_mode: "manual",
        modifier_snapshot: 0,
      });
      expect(error).toBeNull();
    }
    const { error: resolveErr } = await starter.client.rpc("resolve_round", { p_round_id: roundId });
    expect(resolveErr).toBeNull();
    // _rr_active_effects_as_of (drain liveness) counts resolved rounds since
    // the origin cast, so each round must be stamped resolved.
    const { error: markErr } = await admin
      .from("rounds")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", roundId);
    expect(markErr).toBeNull();
  }

  async function tickRows(roundId: string, marker: "bitter_leech_tick" | "dice_tick") {
    const { data, error } = await admin
      .from("spell_casts")
      .select("id, source_cast_id")
      .eq("round_id", roundId)
      .contains("cast_inputs", { [marker]: true });
    expect(error).toBeNull();
    return data ?? [];
  }

  async function roomModifier(player: Player) {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", player.roomId)
      .eq("player_id", player.googleSub)
      .single();
    expect(error).toBeNull();
    return data!.modifier as number;
  }

  /** cups + adjustments + spell_effects must equal the room_players cache. */
  async function expectReconciled(player: Player) {
    const { data, error } = await player.client
      .rpc("get_modifier_breakdown", { p_player_id: player.googleSub, p_room_id: player.roomId })
      .single();
    expect(error).toBeNull();
    const b = data as { cups_made: number; adjustments: number; spell_effects: number };
    expect(b.cups_made + b.adjustments + b.spell_effects).toBe(await roomModifier(player));
  }

  async function expectRoundGone(roundId: string) {
    const { data: round } = await admin.from("rounds").select("id").eq("id", roundId).maybeSingle();
    expect(round).toBeNull();
    const { data: casts } = await admin.from("spell_casts").select("id").eq("round_id", roundId);
    expect(casts).toEqual([]);
  }

  it("Bitter Leech: deleting the origin round succeeds, later ticks stay applied, the drain stops", async () => {
    const caster = await signUp("d441-leech-caster");
    const victim = await signUp("d441-leech-victim");

    // Round 1 — cast Bitter Leech; the drain ticks on the cast round.
    const r1 = await startRound(caster, [victim]);
    await forceHold(admin, caster.googleSub, "Bitter Leech");
    const { error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_target_player_id: victim.googleSub,
    });
    expect(castErr).toBeNull();
    await playRound(caster, r1, [[caster, 10], [victim, 11]]);

    // Round 2 — the drain ticks again; its tick rows point back at round 1.
    const r2 = await startRound(caster, [victim]);
    await playRound(caster, r2, [[caster, 10], [victim, 11]]);
    const r2TicksBefore = await tickRows(r2, "bitter_leech_tick");
    expect(r2TicksBefore).toHaveLength(2);
    expect(r2TicksBefore.every((t) => t.source_cast_id !== null)).toBe(true);
    expect(await roomModifier(caster)).toBe(2);
    expect(await roomModifier(victim)).toBe(-2);

    await makeAdmin(caster.googleSub);
    const { error: delErr } = await caster.client.rpc("admin_delete_round", {
      p_round_id: r1,
      p_reason: "issue #441 test",
    });
    expect(delErr).toBeNull();

    await expectRoundGone(r1);
    // Round 2's ticks survive, still applied, with their provenance nulled.
    const r2TicksAfter = await tickRows(r2, "bitter_leech_tick");
    expect(r2TicksAfter.map((t) => t.id).sort()).toEqual(r2TicksBefore.map((t) => t.id).sort());
    expect(r2TicksAfter.every((t) => t.source_cast_id === null)).toBe(true);
    // Only round 1's tick is reverted.
    expect(await roomModifier(caster)).toBe(1);
    expect(await roomModifier(victim)).toBe(-1);
    await expectReconciled(caster);
    await expectReconciled(victim);

    // Round 3 is still inside the drain's 3-round duration, but its active
    // effect went with the origin cast — no new tick.
    const r3 = await startRound(caster, [victim]);
    await playRound(caster, r3, [[caster, 10], [victim, 11]]);
    expect(await tickRows(r3, "bitter_leech_tick")).toHaveLength(0);
    expect(await roomModifier(caster)).toBe(1);
    expect(await roomModifier(victim)).toBe(-1);
    await expectReconciled(caster);
    await expectReconciled(victim);
  });

  it("Calami-Tea: deleting the origin round succeeds, later dice ticks stay, the drain stops", async () => {
    const caster = await signUp("d441-calami-caster");
    const victim = await signUp("d441-calami-victim");

    const r1 = await startRound(caster, [victim]);
    await forceHold(admin, caster.googleSub, "Calami-Tea");
    const { error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: r1,
      p_chosen_player_ids: [victim.googleSub],
    });
    expect(castErr).toBeNull();
    await playRound(caster, r1, [[caster, 5], [victim, 18]]);

    const r2 = await startRound(caster, [victim]);
    await playRound(caster, r2, [[caster, 5], [victim, 15]]);
    const r2TicksBefore = await tickRows(r2, "dice_tick");
    expect(r2TicksBefore).toHaveLength(1);
    expect(r2TicksBefore[0]!.source_cast_id).not.toBeNull();

    await makeAdmin(caster.googleSub);
    const { error: delErr } = await caster.client.rpc("admin_delete_round", {
      p_round_id: r1,
      p_reason: "issue #441 test",
    });
    expect(delErr).toBeNull();

    await expectRoundGone(r1);
    const r2TicksAfter = await tickRows(r2, "dice_tick");
    expect(r2TicksAfter).toEqual([{ id: r2TicksBefore[0]!.id, source_cast_id: null }]);

    const r3 = await startRound(caster, [victim]);
    await playRound(caster, r3, [[caster, 5], [victim, 15]]);
    expect(await tickRows(r3, "dice_tick")).toHaveLength(0);
  });
});
