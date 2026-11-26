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

// Runs against a real local Supabase stack. Exercises Liquid Courage (issue
// #439, spec #401): "Give another player a d6. In the next 3 rounds they may
// use it as a Reaction to add to their roll."
//
// The gift projects a Courage Token (`courage_token` active effect) on the
// recipient. A live, unspent token is a Reaction Source at Layer 0: the
// recipient is waited on in the Reaction Window and may spend it
// (spend_courage_token), which records a Six Sugars-shaped Pending Spell Die
// on their own roll. "Spent" is derived from that Cast Log row.

const TOKEN_PARAMS = { dice: "1d6", persist: true, participated_rounds_from_cast: 3 };

describe.skipIf(!hasAnonTestEnv)("Liquid Courage (issue #439)", () => {
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

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

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

  /** Moves a round into the past and marks it resolved, so a later one can start. */
  async function resolveInPast(roundId: string, startedMinutesAgo: number) {
    const { error } = await admin
      .from("rounds")
      .update({ status: "resolved", started_at: minutesAgo(startedMinutesAgo), resolved_at: minutesAgo(startedMinutesAgo) })
      .eq("id", roundId);
    expect(error).toBeNull();
  }

  /** A resolved past round; `rolled` players get a layer-0 roll, the rest of `participants` none. */
  async function seedPastRound(roomId: string, participants: string[], startedMinutesAgo: number, rolled = participants) {
    const { data, error } = await admin
      .from("rounds")
      .insert({
        room_id: roomId,
        started_by: participants[0],
        status: "resolved",
        started_at: minutesAgo(startedMinutesAgo),
        resolved_at: minutesAgo(startedMinutesAgo),
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const roundId = data!.id as string;
    cleanup.trackRound(roundId);
    const { error: pErr } = await admin
      .from("round_participants")
      .insert(participants.map((player_id) => ({ round_id: roundId, player_id })));
    expect(pErr).toBeNull();
    if (rolled.length > 0) {
      const { error: rErr } = await admin.from("rolls").insert(
        rolled.map((player_id, i) => ({
          round_id: roundId,
          player_id,
          layer: 0,
          value: 8 + i,
          input_mode: "manual",
          modifier_snapshot: 0,
        })),
      );
      expect(rErr).toBeNull();
    }
    return roundId;
  }

  /** `giver` casts Liquid Courage on `recipient` in `roundId`. */
  async function castGift(giver: Player, recipient: Player, roundId: string) {
    await forceHold(admin, giver.googleSub, "Liquid Courage");
    const { data: castId, error } = await giver.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: recipient.googleSub,
    });
    expect(error).toBeNull();
    return castId as string;
  }

  /** Giver gifts recipient a token in a fresh round, moved 2 hours into the past and resolved. */
  async function gift(label: string, extra: string[] = []) {
    const [giver, recipient, ...others] = await Promise.all(
      ["giver", "recipient", ...extra].map((role) => signUp(`lc-${label}-${role}`)),
    );
    const giftRound = await startRound(giver!, [recipient!, ...others]);
    const castId = await castGift(giver!, recipient!, giftRound);
    await resolveInPast(giftRound, 120);
    return { giver: giver!, recipient: recipient!, others, giftRound, castId };
  }

  async function seedRoll(roundId: string, playerId: string, value: number, discarded: number | null = null) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      discarded_value: discarded,
      input_mode: "manual",
      modifier_snapshot: 0,
    });
    expect(error).toBeNull();
  }

  async function unspent(roundId: string, playerId: string) {
    const { data, error } = await admin.rpc("_unspent_courage_tokens", { p_round_id: roundId, p_player_id: playerId });
    expect(error).toBeNull();
    return data as { effect_id: string; source_cast_id: string }[];
  }

  // ==========================================================================
  // The gift
  // ==========================================================================

  it("is un-benched and the gift projects a Courage Token on the recipient", async () => {
    const { giver, recipient, castId } = await gift("projects");

    const { data, error } = await admin
      .from("spell_active_effects")
      .select("target_player_id, caster_id, effect_kind, effect_params, rounds_remaining")
      .eq("source_cast_id", castId);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        target_player_id: recipient.googleSub,
        caster_id: giver.googleSub,
        effect_kind: "courage_token",
        effect_params: TOKEN_PARAMS,
        rounds_remaining: null,
      },
    ]);
  });

  // ==========================================================================
  // Prompted with no Reaction card; spend once; the d6 lands
  // ==========================================================================

  it("a token is not a Reaction Source in a tie-break window", async () => {
    const { giver, recipient } = await gift("tiebreak");
    const roundId = await startRound(giver, [recipient]);
    const { error } = await giver.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
    await seedRoll(roundId, recipient.googleSub, 10);
    await seedRoll(roundId, giver.googleSub, 13);
    await admin.from("rounds").update({ current_layer: 1 }).eq("id", roundId);

    const { data: count, error: cErr } = await admin.rpc("_is_reaction_source", {
      p_round_id: roundId,
      p_player_id: recipient.googleSub,
    });
    expect(cErr).toBeNull();
    expect(count).toBe(false);
  });

  // ==========================================================================
  // Skip vote
  // ==========================================================================

  // ==========================================================================
  // After advantage
  // ==========================================================================

  // ==========================================================================
  // Lifetime
  // ==========================================================================

  it("lives through the recipient's 3rd round of taking part, counting the gift round and a no-roll round", async () => {
    const { giver, recipient } = await gift("third-round");
    const room = giver.roomId;
    await seedPastRound(room, [giver.googleSub, recipient.googleSub], 100, [giver.googleSub]); // took part, no roll
    await seedPastRound(room, [giver.googleSub], 90); // sat out

    // The live round is the 3rd they take part in.
    const roundId = await startRound(giver, [recipient]);
    expect(await unspent(roundId, recipient.googleSub)).toHaveLength(1);

    const { data: badges, error } = await recipient.client.rpc("get_room_active_effects", { p_room_id: room });
    expect(error).toBeNull();
    expect(badges).toContainEqual(
      expect.objectContaining({ target_player_id: recipient.googleSub, card_name: "Liquid Courage", rounds_remaining: 1 }),
    );
  });

  it("expires after the recipient's 3rd round of taking part", async () => {
    const { giver, recipient } = await gift("fourth-round");
    const room = giver.roomId;
    await seedPastRound(room, [giver.googleSub, recipient.googleSub], 100);
    await seedPastRound(room, [giver.googleSub, recipient.googleSub], 90);

    const roundId = await startRound(giver, [recipient]);
    expect(await unspent(roundId, recipient.googleSub)).toEqual([]);
  });

  // The card says "once in the next 3 rounds", with no day limit (issue #472,
  // Carried Effects): the token follows the recipient into the next day's room
  // and its window keeps counting there.
  it("carries into the next day's room until the recipient has taken part in 3 rounds", async () => {
    const { giver, recipient } = await gift("day-end");
    const tomorrow = await seedDedicatedRoom(admin, cleanup, [giver.googleSub, recipient.googleSub]);
    const first = await seedPastRound(tomorrow, [giver.googleSub, recipient.googleSub], 10);
    // Gift round + nothing yet in tomorrow's room: 1 of 3 used.
    expect(await unspent(first, recipient.googleSub)).toHaveLength(1);

    // Gift round + 2 tomorrow rounds = 3 of 3: spent as of the next round.
    const second = await seedPastRound(tomorrow, [giver.googleSub, recipient.googleSub], 5);
    const third = await seedPastRound(tomorrow, [giver.googleSub, recipient.googleSub], 1);
    expect(await unspent(second, recipient.googleSub)).toHaveLength(1);
    expect(await unspent(third, recipient.googleSub)).toEqual([]);
  });

  // ==========================================================================
  // Not a card
  // ==========================================================================

  // ==========================================================================
  // Detox
  // ==========================================================================

  it("Greater Detox ends an unspent token; Lesser Detox can't", async () => {
    const { giver, recipient, others } = await gift("detox", ["detoxer"]);
    const detoxer = others[0]!;
    const roundId = await startRound(giver, [recipient, detoxer]);
    const [token] = await unspent(roundId, recipient.googleSub);

    const lesser = await forceHold(admin, detoxer.googleSub, "Lesser Detox");
    const { error: lesserErr } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: token!.effect_id,
    });
    expect(lesserErr).not.toBeNull();
    expect(await unspent(roundId, recipient.googleSub)).toHaveLength(1);
    // One held card per player: put Lesser Detox back before handing over Greater.
    await admin.from("spell_deck_instances").update({ location: "in_deck", held_by_player: null }).eq("id", lesser);

    await forceHold(admin, detoxer.googleSub, "Greater Detox");
    const { data: offered } = await detoxer.client.rpc("get_dispellable_active_effects", { p_round_id: roundId });
    expect((offered as { effect_id: string }[]).map((r) => r.effect_id)).toContain(token!.effect_id);
    const { error: greaterErr } = await detoxer.client.rpc("end_active_effect", {
      p_round_id: roundId,
      p_effect_id: token!.effect_id,
    });
    expect(greaterErr).toBeNull();
    expect(await unspent(roundId, recipient.googleSub)).toEqual([]);
  });

  // ==========================================================================
  // Replay, stacking
  // ==========================================================================
});
