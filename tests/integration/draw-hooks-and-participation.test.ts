import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
  seedActiveEffect,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Covers the shared
// foundations #435 (spec #401 F3 + F6) adds ahead of the Draw Redirect cards
// and the Courage Token:
//   * active-effect liveness gains a 4th condition, "not consumed", recorded
//     on the source cast (cast_inputs.consumed_by_round / consumed_by_draw);
//   * _rr_participated_rounds_elapsed counts the resolved rounds one player
//     took part in, next to _rr_effect_rounds_elapsed's count of room rounds.
// The draw-hook refactor itself (_apply_crit_redirect, _land_drawn_instance)
// is behaviour-neutral and covered by the existing draw / manual-draw /
// keep-or-swap / admin-proxy / puppet suites staying green.
describe.skipIf(!hasAnonTestEnv)("draw hooks and participated rounds (#435)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  async function seedPlayers(label: string, count: number): Promise<string[]> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ids = Array.from({ length: count }, (_, i) => `google-sub-${label}-${i}-${stamp}`);
    ids.forEach((id) => cleanup.trackPlayerId(id));
    const { error } = await admin
      .from("players")
      .insert(ids.map((id) => ({ id, email: `${id}@example.com`, display_name: id })));
    if (error) throw error;
    return ids;
  }

  /** A round with an explicit started_at so ordering is deterministic. */
  async function seedRound(opts: {
    roomId: string;
    startedBy: string;
    startedAt: Date;
    status?: "resolved" | "cancelled";
    participantIds: string[];
  }): Promise<{ id: string; startedAt: string }> {
    const status = opts.status ?? "resolved";
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: opts.roomId,
        started_by: opts.startedBy,
        started_at: opts.startedAt.toISOString(),
        status,
        resolved_at: status === "resolved" ? opts.startedAt.toISOString() : null,
      })
      .select("id, started_at")
      .single();
    if (error) throw error;
    cleanup.trackRound(data.id as string);
    if (opts.participantIds.length > 0) {
      const { error: pErr } = await admin
        .from("round_participants")
        .insert(opts.participantIds.map((player_id) => ({ round_id: data.id, player_id })));
      if (pErr) throw pErr;
    }
    return { id: data.id as string, startedAt: data.started_at as string };
  }

  async function participatedElapsed(
    roomId: string,
    playerId: string,
    sourceStartedAt: string,
    asOfStartedAt: string | null,
  ): Promise<number> {
    const { data, error } = await admin.rpc("_rr_participated_rounds_elapsed", {
      p_room_id: roomId,
      p_player_id: playerId,
      p_source_started_at: sourceStartedAt,
      p_as_of_started_at: asOfStartedAt,
    });
    if (error) throw error;
    return data as number;
  }

  describe("_rr_participated_rounds_elapsed", () => {
    it("skips rounds the player sat out and counts rounds they took part in without rolling", async () => {
      const [target, other] = await seedPlayers("participated", 2);
      const roomId = await seedDedicatedRoom(admin, cleanup, [target!, other!]);
      const otherRoomId = await seedDedicatedRoom(admin, cleanup, [target!, other!]);
      const t0 = Date.now() - 60 * 60 * 1000;
      const at = (minutes: number) => new Date(t0 + minutes * 60 * 1000);

      // r1: target takes part and rolls.
      const r1 = await seedRound({ roomId, startedBy: other!, startedAt: at(1), participantIds: [target!, other!] });
      const { error: rollErr } = await admin.from("rolls").insert({
        round_id: r1.id,
        player_id: target,
        layer: 0,
        value: 12,
        input_mode: "manual",
        modifier_snapshot: 0,
      });
      expect(rollErr).toBeNull();
      // r2: target takes part but never rolls (a Tea Cosy / exempt / debt
      // round) -- still counts.
      const r2 = await seedRound({ roomId, startedBy: other!, startedAt: at(2), participantIds: [target!, other!] });
      // r3: target sits out -- skipped.
      await seedRound({ roomId, startedBy: other!, startedAt: at(3), participantIds: [other!] });
      // A cancelled round the target was in -- not resolved, so not counted.
      await seedRound({
        roomId,
        startedBy: other!,
        startedAt: at(4),
        status: "cancelled",
        participantIds: [target!, other!],
      });
      // Another room's round -- out of scope.
      await seedRound({ roomId: otherRoomId, startedBy: other!, startedAt: at(5), participantIds: [target!] });
      // r6: target takes part again.
      const r6 = await seedRound({ roomId, startedBy: other!, startedAt: at(6), participantIds: [target!, other!] });

      // Unbounded as-of: r1, r2, r6.
      expect(await participatedElapsed(roomId, target!, r1.startedAt, null)).toBe(3);
      // As-of bound is strict, like _rr_effect_rounds_elapsed: r6 excluded.
      expect(await participatedElapsed(roomId, target!, r1.startedAt, r6.startedAt)).toBe(2);
      // Source bound is inclusive: from r2 -> r2, r6.
      expect(await participatedElapsed(roomId, target!, r2.startedAt, null)).toBe(2);
      // The player who took part in every resolved round counts all four.
      expect(await participatedElapsed(roomId, other!, r1.startedAt, null)).toBe(4);
    });
  });

  describe("active-effect liveness: not spent", () => {
    async function liveEffectIds(roomId: string, asOfRoundId: string): Promise<string[]> {
      const { data, error } = await admin.rpc("_rr_active_effects_as_of", {
        p_room_id: roomId,
        p_as_of_round_id: asOfRoundId,
      });
      if (error) throw error;
      return ((data ?? []) as { id: string }[]).map((r) => r.id);
    }

    async function markConsumed(castId: string, inputs: Record<string, unknown>) {
      const { error } = await admin.from("spell_casts").update({ cast_inputs: inputs }).eq("id", castId);
      if (error) throw error;
    }

    for (const key of ["consumed_by_round", "consumed_by_draw"] as const) {
      it(`drops a draw_redirect mark once its source cast records ${key}`, async () => {
        const [caster, target] = await seedPlayers(`consumed-${key}`, 2);
        const roomId = await seedDedicatedRoom(admin, cleanup, [caster!, target!]);
        const { effectId, castId, roundId } = await seedActiveEffect(admin, cleanup, {
          roomId,
          targetPlayerId: target!,
          casterId: caster!,
          cardName: "Marked for Brew",
          effectKind: "draw_redirect",
          effectParams: { trigger: "next_crit", beneficiary_player_id: caster },
          roundsRemaining: 5,
        });

        expect(await liveEffectIds(roomId, roundId)).toContain(effectId);

        await markConsumed(castId, { [key]: key === "consumed_by_round" ? roundId : crypto.randomUUID() });

        expect(await liveEffectIds(roomId, roundId)).not.toContain(effectId);
      });
    }

    it("keeps a mark live when cast_inputs carries unrelated keys", async () => {
      const [caster, target] = await seedPlayers("consumed-unrelated", 2);
      const roomId = await seedDedicatedRoom(admin, cleanup, [caster!, target!]);
      const { effectId, castId, roundId } = await seedActiveEffect(admin, cleanup, {
        roomId,
        targetPlayerId: target!,
        casterId: caster!,
        cardName: "Marked for Brew",
        effectKind: "draw_redirect",
        effectParams: { trigger: "next_crit", beneficiary_player_id: caster },
        roundsRemaining: 5,
      });

      await markConsumed(castId, { dice_roll: 4 });

      expect(await liveEffectIds(roomId, roundId)).toContain(effectId);
    });
  });

  describe("draw_spell_card_as with the crit's round (puppet crit entry point)", () => {
    it("draws for the rolled-for player and rejects a round from another room", async () => {
      const { client: adminClient, googleSub: adminId } = await signUpSignInAndEnterRoom(
        admin,
        cleanup,
        "draw-hook-puppet-admin",
      );
      const { error: adminErr } = await admin.from("players").update({ is_admin: true }).eq("id", adminId);
      if (adminErr) throw adminErr;
      const [target] = await seedPlayers("draw-hook-puppet-target", 1);
      const roomId = await seedDedicatedRoom(admin, cleanup, [adminId, target!], { isTest: true });
      const otherRoomId = await seedDedicatedRoom(admin, cleanup, [adminId, target!], { isTest: true });
      const round = await seedRound({ roomId, startedBy: adminId, startedAt: new Date(), participantIds: [target!] });
      const otherRound = await seedRound({
        roomId: otherRoomId,
        startedBy: adminId,
        startedAt: new Date(),
        participantIds: [target!],
      });

      const { error: wrongRoundErr } = await adminClient.rpc("draw_spell_card_as", {
        p_trigger: "nat20",
        p_room_id: roomId,
        p_round_id: otherRound.id,
        p_player_id: target,
      });
      expect(wrongRoundErr?.message).toMatch(/round is not in this room/);

      const { data, error } = await adminClient.rpc("draw_spell_card_as", {
        p_trigger: "nat20",
        p_room_id: roomId,
        p_round_id: round.id,
        p_player_id: target,
      });
      expect(error).toBeNull();
      const [row] = data as { instance_id: string; needs_swap_decision: boolean }[];
      expect(row!.needs_swap_decision).toBe(false);

      const { data: instance } = await admin
        .from("spell_deck_instances")
        .select("location, held_by_player")
        .eq("id", row!.instance_id)
        .single();
      expect(instance).toEqual({ location: "held", held_by_player: target });
    });
  });
});
