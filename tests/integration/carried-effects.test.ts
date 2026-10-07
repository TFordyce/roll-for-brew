import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byTarget,
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
  roundModifierEffects,
  seedActiveEffect,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Exercises Carried Effects (issue
// #472, ADR 0005 "Carried Effect amendment"): a multi-round effect follows its
// TARGET into later rooms, timed on the Participation Clock (resolved rounds
// the target took part in, across rooms of the same kind) and derived at read
// time by _rr_active_effects_as_of -- no row is copied into the new room.
//
// Most tests read the projection directly (service_role may call the
// internal reader); two drive the real resolver for Caffeine Crash and Bitter
// Leech in the target's next room.

describe.skipIf(!hasAnonTestEnv)("Carried Effects (issue #472)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  const signUp = (label: string) => signUpSignInAndEnterRoom(admin, cleanup, label);
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  /** A resolved round started `m` minutes ago; `participants` get a participant row only. */
  async function seedRound(roomId: string, participants: string[], m: number, starter: string) {
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: roomId,
        started_by: starter,
        status: "resolved",
        started_at: minutesAgo(m),
        resolved_at: minutesAgo(m),
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const roundId = (data as { id: string }).id;
    cleanup.trackRound(roundId);
    if (participants.length > 0) {
      const { error: pErr } = await admin
        .from("round_participants")
        .insert(participants.map((player_id) => ({ round_id: roundId, player_id })));
      expect(pErr).toBeNull();
    }
    return roundId;
  }

  /** Effect rows live in `roomId` as of `roundId`. */
  async function liveAsOf(roomId: string, roundId: string) {
    const { data, error } = await admin.rpc("_rr_active_effects_as_of", {
      p_room_id: roomId,
      p_as_of_round_id: roundId,
    });
    expect(error).toBeNull();
    return (data as { id: string; room_id: string }[]) ?? [];
  }

  /** Day 1 room with the effect cast in its round (300 min ago), plus an empty day-2 room. */
  async function dayOneEffect(opts: {
    caster: string;
    target: string;
    roundsRemaining: number | null;
    effectParams?: Record<string, unknown>;
    card?: string;
    effectKind?: string;
    isTestDay2?: boolean;
    day2Extra?: string[];
  }) {
    const day1 = await seedDedicatedRoom(admin, cleanup, [opts.caster, opts.target]);
    const day2 = await seedDedicatedRoom(admin, cleanup, [opts.target, ...(opts.day2Extra ?? [])], { isTest: opts.isTestDay2 });
    const castRound = await seedRound(day1, [opts.caster, opts.target], 300, opts.caster);
    const { effectId } = await seedActiveEffect(admin, cleanup, {
      roomId: day1,
      targetPlayerId: opts.target,
      casterId: opts.caster,
      cardName: opts.card ?? "Cast-Iron Kettle",
      effectKind: opts.effectKind ?? "flat_modifier",
      effectParams: opts.effectParams ?? {},
      roundsRemaining: opts.roundsRemaining,
      roundId: castRound,
    });
    return { day1, day2, castRound, effectId };
  }

  it("an effect cast on day 1 applies on the target's day-2 rounds and expires after the right number of participated rounds", async () => {
    const [caster, target] = await Promise.all([signUp("carry-caster"), signUp("carry-target")]);
    const { day2, effectId } = await dayOneEffect({
      caster: caster.googleSub,
      target: target.googleSub,
      roundsRemaining: 3,
    });
    const d2r1 = await seedRound(day2, [target.googleSub], 200, target.googleSub);
    const d2r2 = await seedRound(day2, [target.googleSub], 100, target.googleSub);
    const d2r3 = await seedRound(day2, [target.googleSub], 50, target.googleSub);

    // The cast round is participated round 1 of 3: as of d2r1 the clock is 1,
    // as of d2r2 it is 2, as of d2r3 it is 3 -> spent.
    const asOfR1 = await liveAsOf(day2, d2r1);
    expect(asOfR1.map((r) => r.id)).toEqual([effectId]);
    // The carried row is presented as the new room's own.
    expect(asOfR1[0]!.room_id).toBe(day2);
    expect((await liveAsOf(day2, d2r2)).map((r) => r.id)).toEqual([effectId]);
    expect(await liveAsOf(day2, d2r3)).toEqual([]);
  });

  it("a target who sits out rounds does not burn duration", async () => {
    const [caster, target] = await Promise.all([signUp("sit-caster"), signUp("sit-target")]);
    const { day2, effectId } = await dayOneEffect({
      caster: caster.googleSub,
      target: target.googleSub,
      roundsRemaining: 2,
    });
    await seedRound(day2, [caster.googleSub], 250, caster.googleSub);
    await seedRound(day2, [caster.googleSub], 200, caster.googleSub);
    const joined = await seedRound(day2, [target.googleSub], 100, target.googleSub);
    const later = await seedRound(day2, [target.googleSub], 50, target.googleSub);

    // Clock as of `joined` = 1 (cast round only); as of `later` = 2 -> spent.
    expect((await liveAsOf(day2, joined)).map((r) => r.id)).toEqual([effectId]);
    expect(await liveAsOf(day2, later)).toEqual([]);
  });

  it("a joined-but-unrolled round counts on the clock", async () => {
    const [caster, target] = await Promise.all([signUp("join-caster"), signUp("join-target")]);
    const { day2 } = await dayOneEffect({
      caster: caster.googleSub,
      target: target.googleSub,
      roundsRemaining: 2,
    });
    // A participant row with no roll still ticks the clock.
    await seedRound(day2, [target.googleSub], 100, target.googleSub);
    const asOf = await seedRound(day2, [target.googleSub], 50, target.googleSub);
    expect(await liveAsOf(day2, asOf)).toEqual([]);
  });

  it("a no-duration effect is not live in the next day's room", async () => {
    const [caster, target] = await Promise.all([signUp("ward-caster"), signUp("ward-target")]);
    const { day1, day2, effectId } = await dayOneEffect({
      caster: caster.googleSub,
      target: target.googleSub,
      roundsRemaining: null,
    });
    const d2 = await seedRound(day2, [target.googleSub], 100, target.googleSub);
    expect(await liveAsOf(day2, d2)).toEqual([]);
    // Still live in its own day's room.
    const d1 = await seedRound(day1, [target.googleSub], 10, target.googleSub);
    expect((await liveAsOf(day1, d1)).map((r) => r.id)).toEqual([effectId]);
  });

  it("a later room's effect never leaks into an earlier as-of round", async () => {
    const [caster, target] = await Promise.all([signUp("leak-caster"), signUp("leak-target")]);
    const earlier = await seedDedicatedRoom(admin, cleanup, [caster.googleSub, target.googleSub]);
    const later = await seedDedicatedRoom(admin, cleanup, [caster.googleSub, target.googleSub]);
    const earlyRound = await seedRound(earlier, [target.googleSub], 300, target.googleSub);
    const lateCast = await seedRound(later, [caster.googleSub, target.googleSub], 100, caster.googleSub);
    await seedActiveEffect(admin, cleanup, {
      roomId: later,
      targetPlayerId: target.googleSub,
      casterId: caster.googleSub,
      cardName: "Cast-Iron Kettle",
      effectKind: "flat_modifier",
      roundsRemaining: 5,
      roundId: lateCast,
    });
    expect(await liveAsOf(earlier, earlyRound)).toEqual([]);
  });

  it("does not carry between a Test Room and a real room", async () => {
    const [caster, target] = await Promise.all([signUp("tr-caster"), signUp("tr-target")]);
    const { day2 } = await dayOneEffect({
      caster: caster.googleSub,
      target: target.googleSub,
      roundsRemaining: 5,
      isTestDay2: true,
    });
    const d2 = await seedRound(day2, [target.googleSub], 100, target.googleSub);
    expect(await liveAsOf(day2, d2)).toEqual([]);
  });

  it("Marked for Brew and Courage Token (no duration) stay in their day's room, but their windows count across rooms", async () => {
    const [caster, target] = await Promise.all([signUp("win-caster"), signUp("win-target")]);
    const mark = await dayOneEffect({
      caster: caster.googleSub,
      target: target.googleSub,
      roundsRemaining: null,
      effectKind: "draw_redirect",
      effectParams: { trigger: "next_crit", persist: true, participated_rounds_after_cast: 2 },
      card: "Marked for Brew",
    });
    const token = await seedActiveEffect(admin, cleanup, {
      roomId: mark.day1,
      targetPlayerId: target.googleSub,
      casterId: caster.googleSub,
      cardName: "Liquid Courage",
      effectKind: "courage_token",
      effectParams: { persist: true, participated_rounds_from_cast: 2 },
      roundsRemaining: null,
      roundId: mark.castRound,
    });
    // Not carried into the next day's room.
    const a = await seedRound(mark.day2, [target.googleSub], 200, target.googleSub);
    expect(await liveAsOf(mark.day2, a)).toEqual([]);

    // The clock itself counts across rooms: day 1's cast round (inclusive) and
    // a day-2 round are two participated rounds as of a later day-2 round.
    const b = await seedRound(mark.day2, [target.googleSub], 100, target.googleSub);
    const { data: bRow } = await admin.from("rounds").select("started_at").eq("id", b).single();
    const { data: castRow } = await admin.from("rounds").select("started_at").eq("id", mark.castRound).single();
    const { data: elapsed, error } = await admin.rpc("_rr_participated_rounds_elapsed", {
      p_room_id: mark.day2,
      p_player_id: target.googleSub,
      p_source_started_at: (castRow as { started_at: string }).started_at,
      p_as_of_started_at: (bRow as { started_at: string }).started_at,
    });
    expect(error).toBeNull();
    expect(elapsed).toBe(2);
    expect(token.effectId).toBeTruthy();
  });

  // --------------------------------------------------------------------------
  // Resolver-level: the card behaviour in the new room.
  // --------------------------------------------------------------------------

  async function playDay2Round(
    client: SupabaseClient,
    roomId: string,
    rolls: [string, number][],
    joiners: SupabaseClient[],
  ) {
    const { data: roundId, error } = await client.rpc("start_round", { p_room_id: roomId });
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const j of joiners) {
      const { error: dErr } = await j.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    const { error: closeErr } = await client.rpc("close_round", { p_round_id: roundId });
    expect(closeErr).toBeNull();
    for (const [playerId, value] of rolls) {
      const { error: rErr } = await admin.from("rolls").insert({
        round_id: roundId,
        player_id: playerId,
        layer: 0,
        value,
        input_mode: "manual",
        modifier_snapshot: 0,
      });
      expect(rErr).toBeNull();
    }
    const { error: resErr } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(resErr).toBeNull();
    const { error: stampErr } = await admin
      .from("rounds")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", roundId);
    expect(stampErr).toBeNull();
    return roundId as string;
  }

  async function roomModifier(roomId: string, playerId: string) {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", roomId)
      .eq("player_id", playerId)
      .single();
    expect(error).toBeNull();
    return (data as { modifier: number }).modifier;
  }

  it("Caffeine Crash forces -1 in the new room for the remaining participated rounds, then reverts to that room's base", async () => {
    const [caster, target, other] = await Promise.all([signUp("cc-caster"), signUp("cc-target"), signUp("cc-other")]);
    const { day2 } = await dayOneEffect({
      caster: caster.googleSub,
      target: target.googleSub,
      roundsRemaining: 2,
      card: "Caffeine Crash",
      effectKind: "set_modifier",
      effectParams: { value: -1 },
      day2Extra: [other.googleSub],
    });
    // The cast round was participated round 1 of 2, so exactly one day-2 round
    // still has the -1 forced; the next reverts to the room's own base (0).
    const r1 = await playDay2Round(
      target.client,
      day2,
      [
        [target.googleSub, 10],
        [other.googleSub, 12],
      ],
      [other.client],
    );
    const r1Effects = (await roundModifierEffects(admin, target.client, r1)).data ?? [];
    expect(byTarget(r1Effects, target.googleSub)).toMatchObject([
      { effect_kind: "set_modifier", effect_params: { value: -1 }, card_name: "Caffeine Crash" },
    ]);
    const r2 = await playDay2Round(
      target.client,
      day2,
      [
        [target.googleSub, 10],
        [other.googleSub, 12],
      ],
      [other.client],
    );
    const r2Effects = (await roundModifierEffects(admin, target.client, r2)).data ?? [];
    expect(byTarget(r2Effects, target.googleSub)).toEqual([]);
    expect(await roomModifier(day2, target.googleSub)).toBe(0);
  });

  it("Bitter Leech ticks on the target's clock; the caster's gain is lost when the caster is absent", async () => {
    const [caster, target, other] = await Promise.all([signUp("bl-caster"), signUp("bl-target"), signUp("bl-other")]);
    const { day2 } = await dayOneEffect({
      caster: caster.googleSub,
      target: target.googleSub,
      roundsRemaining: 3,
      card: "Bitter Leech",
      effectKind: "persistent_modifier_transfer",
      effectParams: { per_round_delta: 1 },
      day2Extra: [other.googleSub],
    });
    // The caster is not in the day-2 room and does not take part.
    await playDay2Round(
      target.client,
      day2,
      [
        [target.googleSub, 10],
        [other.googleSub, 12],
      ],
      [other.client],
    );
    expect(await roomModifier(day2, target.googleSub)).toBe(-1);
    const { data: casterRows } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", day2)
      .eq("player_id", caster.googleSub);
    expect(casterRows).toEqual([]);
  });
});
