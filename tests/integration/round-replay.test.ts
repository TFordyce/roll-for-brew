import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Exercises the Round Replay mechanism —
// Time for Brew (supabase/migrations/0090_round_replay.sql, issue #315, spec
// #302 §11): a surviving round_replay cast makes its just-resolved round a
// pending scrap/keep decision; confirm scraps it to a clean generation-1
// round, decline / the 5-minute stall sweep keeps it. Asserts on externally
// observable outcomes only (spec section: Testing Decisions).

describe.skipIf(!hasAnonTestEnv)("round replay — Time for Brew (issue #315)", () => {
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

  /** Seeds a spell_casts row directly, decoupled from any catalog card's own mechanics. */
  async function seedCast(
    roundId: string,
    casterId: string,
    donorCard: string,
    row: {
      effectKind: string;
      effectParams?: Record<string, unknown>;
      targetPlayerId?: string | null;
      castInputs?: Record<string, unknown> | null;
      parentCastId?: string | null;
      reactionWindowId?: string | null;
    },
  ) {
    const instanceId = await forceHold(admin, casterId, donorCard);
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);

    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: casterId,
        card_instance_id: instanceId,
        target_player_id: row.targetPlayerId ?? null,
        target_pending: false,
        effect_kind: row.effectKind,
        effect_params: row.effectParams ?? {},
        cast_inputs: row.castInputs ?? null,
        parent_cast_id: row.parentCastId ?? null,
        reaction_window_id: row.reactionWindowId ?? null,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function openWindow(roundId: string) {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** start_round + declare others + close_round; returns the round id. */
  async function openAndCloseRound(
    starter: Awaited<ReturnType<typeof signUp>>,
    others: Awaited<ReturnType<typeof signUp>>[],
  ) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    const { error: cErr } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(cErr).toBeNull();
    return roundId as string;
  }

  /** resolve_round(uuid) then the 4-arg resolve_round that flips the round to 'resolved'. */
  async function resolveToBrewer(client: SupabaseClient, roundId: string, brewerId: string) {
    const { error: outErr } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(outErr).toBeNull();
    const { error: resErr } = await client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: brewerId,
      p_cups_made: 2,
    });
    expect(resErr).toBeNull();
  }

  async function modifierOf(roomId: string, playerId: string) {
    const { data } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", roomId)
      .eq("player_id", playerId)
      .single();
    return data!.modifier as number;
  }

  it("records a pending decision after a surviving Time for Brew resolves, and locks start_round", async () => {
    const [caster, other] = await Promise.all([signUp("replay-a"), signUp("replay-b")]);
    const roundId = await openAndCloseRound(caster, [other]);

    await seedRoll(roundId, caster.googleSub, 5);
    await seedRoll(roundId, other.googleSub, 12);
    await seedCast(roundId, caster.googleSub, "Time for Brew", { effectKind: "round_replay" });

    await resolveToBrewer(caster.client, roundId, caster.googleSub);

    const { data: recorded, error: recErr } = await caster.client.rpc("record_pending_round_replay", {
      p_round_id: roundId,
    });
    expect(recErr).toBeNull();
    expect(recorded).toBe(true);

    const { data: pending } = await admin
      .from("pending_round_replay")
      .select("caster_id, room_id")
      .eq("round_id", roundId)
      .single();
    expect(pending!.caster_id).toBe(caster.googleSub);
    expect(pending!.room_id).toBe(caster.roomId);

    // start_round is room-locked while the decision is pending (RFB47).
    const { error: startErr } = await other.client.rpc("start_round");
    expect(startErr).not.toBeNull();
    expect((startErr as { code?: string }).code).toBe("RFB47");
  });

  it("confirm scraps the round to a clean generation-1 round and reverts the brewer's modifier gain", async () => {
    const [caster, other] = await Promise.all([signUp("replay-c"), signUp("replay-d")]);
    const roundId = await openAndCloseRound(caster, [other]);
    const windowId = await openWindow(roundId);

    await seedRoll(roundId, caster.googleSub, 5);
    await seedRoll(roundId, other.googleSub, 12);
    // A realistic reaction cast: it references generation 0's window, which the
    // scrap must drop before deleting that window row.
    await seedCast(roundId, caster.googleSub, "Time for Brew", {
      effectKind: "round_replay",
      reactionWindowId: windowId,
    });
    // A pre-roll persistent-modifier transfer this generation — its durable
    // deltas must be backed out on scrap.
    await seedCast(roundId, caster.googleSub, "Chai-nge of Heart", {
      effectKind: "persistent_modifier_transfer",
      effectParams: { direction: "caster_gains" },
      targetPlayerId: other.googleSub,
      castInputs: { caster_modifier: 0, target_modifier: 4 },
    });
    // A Brew Rating against generation 0 — discarded on scrap.
    await admin.from("brew_ratings").insert({
      round_id: roundId,
      brewer_id: other.googleSub,
      rater_player_id: caster.googleSub,
      score: 4,
    });

    // `other` brews (lower roll would be caster; pick `other` explicitly so the
    // gain lands on a known player).
    await resolveToBrewer(caster.client, roundId, other.googleSub);
    expect(await modifierOf(caster.roomId, other.googleSub)).toBe(2);

    await caster.client.rpc("record_pending_round_replay", { p_round_id: roundId });

    const { error: confErr } = await caster.client.rpc("confirm_round_replay", { p_round_id: roundId });
    expect(confErr).toBeNull();

    const { data: round } = await admin
      .from("rounds")
      .select("status, current_layer, replay_generation, brewer_id, cups_made, brewer_modifier_gain, scrapped_generations")
      .eq("id", roundId)
      .single();
    expect(round!.status).toBe("closed");
    expect(round!.current_layer).toBe(0);
    expect(round!.replay_generation).toBe(1);
    expect(round!.brewer_id).toBeNull();
    expect(round!.cups_made).toBeNull();
    expect(round!.brewer_modifier_gain).toBe(0);
    expect((round!.scrapped_generations as unknown[]).length).toBe(1);
    expect((round!.scrapped_generations as { generation: number }[])[0]!.generation).toBe(0);

    // Generation-0 rolls / non-round_replay casts / reaction windows are gone;
    // the round_replay cast stays, marked scrapped.
    const { count: rollCount } = await admin
      .from("rolls")
      .select("*", { count: "exact", head: true })
      .eq("round_id", roundId);
    expect(rollCount).toBe(0);
    const { data: casts } = await admin
      .from("spell_casts")
      .select("effect_kind, cast_inputs, reaction_window_id")
      .eq("round_id", roundId);
    expect(casts!.length).toBe(1);
    expect(casts![0]!.effect_kind).toBe("round_replay");
    expect((casts![0]!.cast_inputs as { scrapped: boolean }).scrapped).toBe(true);
    expect(casts![0]!.reaction_window_id).toBeNull();

    const { count: windowCount } = await admin
      .from("spell_reaction_windows")
      .select("*", { count: "exact", head: true })
      .eq("round_id", roundId);
    expect(windowCount).toBe(0);

    const { count: ratingCount } = await admin
      .from("brew_ratings")
      .select("*", { count: "exact", head: true })
      .eq("round_id", roundId);
    expect(ratingCount).toBe(0);

    // Brewer's tea-making gain and the Chai-nge transfer's durable deltas are
    // both backed out — every affected player reconciles to their pre-round
    // modifier.
    expect(await modifierOf(caster.roomId, other.googleSub)).toBe(0);
    expect(await modifierOf(caster.roomId, caster.googleSub)).toBe(0);

    // The pending decision is consumed, so start_round's replay lock (RFB47)
    // is gone. (It still fails the ordinary one-active-per-round guard, since
    // the scrapped round is itself the room's live generation-1 round now.)
    const { count: pendingCount } = await admin
      .from("pending_round_replay")
      .select("*", { count: "exact", head: true })
      .eq("round_id", roundId);
    expect(pendingCount).toBe(0);
    const { error: startErr } = await other.client.rpc("start_round");
    expect((startErr as { code?: string } | null)?.code).not.toBe("RFB47");
  });

  it("decline keeps the resolved round standing and clears the pending decision", async () => {
    const [caster, other] = await Promise.all([signUp("replay-e"), signUp("replay-f")]);
    const roundId = await openAndCloseRound(caster, [other]);

    await seedRoll(roundId, caster.googleSub, 5);
    await seedRoll(roundId, other.googleSub, 12);
    await seedCast(roundId, caster.googleSub, "Time for Brew", { effectKind: "round_replay" });
    await resolveToBrewer(caster.client, roundId, other.googleSub);
    await caster.client.rpc("record_pending_round_replay", { p_round_id: roundId });

    const { error: decErr } = await caster.client.rpc("decline_round_replay", { p_round_id: roundId });
    expect(decErr).toBeNull();

    const { data: round } = await admin
      .from("rounds")
      .select("status, replay_generation, brewer_id")
      .eq("id", roundId)
      .single();
    expect(round!.status).toBe("resolved");
    expect(round!.replay_generation).toBe(0);
    expect(round!.brewer_id).toBe(other.googleSub);
    expect(await modifierOf(caster.roomId, other.googleSub)).toBe(2);

    const { data: cast } = await admin
      .from("spell_casts")
      .select("cast_inputs")
      .eq("round_id", roundId)
      .eq("effect_kind", "round_replay")
      .single();
    expect((cast!.cast_inputs as { scrapped: boolean }).scrapped).toBe(false);

    const { count: pendingCount } = await admin
      .from("pending_round_replay")
      .select("*", { count: "exact", head: true })
      .eq("round_id", roundId);
    expect(pendingCount).toBe(0);
  });

  it("a countered Time for Brew never becomes a pending decision", async () => {
    const [caster, other] = await Promise.all([signUp("replay-g"), signUp("replay-h")]);
    const roundId = await openAndCloseRound(caster, [other]);

    await seedRoll(roundId, caster.googleSub, 5);
    await seedRoll(roundId, other.googleSub, 12);
    const replayCastId = await seedCast(roundId, caster.googleSub, "Time for Brew", {
      effectKind: "round_replay",
    });
    // `other` counters it and wins the contest (dc_d20 15 >= dc 5).
    await seedCast(roundId, other.googleSub, "Tannin Tantrum", {
      effectKind: "contested_negate",
      effectParams: {},
      parentCastId: replayCastId,
      castInputs: { dc_d20: 15, dc: 5 },
    });

    await resolveToBrewer(caster.client, roundId, other.googleSub);

    const { data: cast } = await admin
      .from("spell_casts")
      .select("negated")
      .eq("id", replayCastId)
      .single();
    expect(cast!.negated).toBe(true);

    const { data: recorded } = await caster.client.rpc("record_pending_round_replay", {
      p_round_id: roundId,
    });
    expect(recorded).toBe(false);
    const { count } = await admin
      .from("pending_round_replay")
      .select("*", { count: "exact", head: true })
      .eq("round_id", roundId);
    expect(count).toBe(0);
  });

  it("auto_decline_stalled_round_replays clears a decision left past the 5-minute window", async () => {
    const [caster, other] = await Promise.all([signUp("replay-i"), signUp("replay-j")]);
    const roundId = await openAndCloseRound(caster, [other]);

    await seedRoll(roundId, caster.googleSub, 5);
    await seedRoll(roundId, other.googleSub, 12);
    await seedCast(roundId, caster.googleSub, "Time for Brew", { effectKind: "round_replay" });
    await resolveToBrewer(caster.client, roundId, other.googleSub);
    await caster.client.rpc("record_pending_round_replay", { p_round_id: roundId });

    // Back-date the decision past the stall window.
    await admin
      .from("pending_round_replay")
      .update({ created_at: new Date(Date.now() - 6 * 60_000).toISOString() })
      .eq("round_id", roundId);

    const { data: cleared, error } = await caster.client.rpc("auto_decline_stalled_round_replays");
    expect(error).toBeNull();
    expect(cleared).toBeGreaterThanOrEqual(1);

    const { count } = await admin
      .from("pending_round_replay")
      .select("*", { count: "exact", head: true })
      .eq("round_id", roundId);
    expect(count).toBe(0);

    // The round still stands.
    const { data: round } = await admin.from("rounds").select("status").eq("id", roundId).single();
    expect(round!.status).toBe("resolved");
  });
});
