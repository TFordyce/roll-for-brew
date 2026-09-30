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

// Runs against a real Supabase stack. Issue #395: the base half of
// room_players.modifier (_rr_base_modifier) and get_modifier_breakdown's first
// column sum the tea-making gain actually applied (rounds.brewer_modifier_gain),
// not rounds.cups_made -- so a gain suppressed by Drip Tray
// (tea_maker_override no_modifier_gain) or an Eternal Steep
// (block_earned_modifier) ward stays suppressed when the modifier cache is
// recomputed later in the day.
describe.skipIf(!hasAnonTestEnv)("suppressed tea-making gain survives a modifier recompute (#395)", () => {
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

  async function openAndCloseRound(starter: Player, others: Player[]) {
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

  // Computes the outcome with the pure resolve_round(uuid), then commits it
  // with the 4-arg resolve_round -- the same two calls Layer finalization
  // makes (finalize_layer).
  async function resolve(client: SupabaseClient, roundId: string) {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    const out = data as { brewer_id: string | null; cups_made: number; no_modifier_gain: boolean };
    const { error: commitErr } = await client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: out.brewer_id,
      p_cups_made: out.cups_made,
      p_no_modifier_gain: out.no_modifier_gain,
    });
    expect(commitErr).toBeNull();
    return out;
  }

  async function liveModifier(p: Player) {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", p.roomId)
      .eq("player_id", p.googleSub)
      .single();
    expect(error).toBeNull();
    return data!.modifier as number;
  }

  async function breakdown(p: Player) {
    const { data, error } = await p.client.rpc("get_modifier_breakdown", {
      p_player_id: p.googleSub,
      p_room_id: p.roomId,
    });
    expect(error).toBeNull();
    return (data as { cups_made: number; adjustments: number; spell_effects: number }[])[0]!;
  }

  // Forces _rr_recompute_modifier_cache for `brewer`: admin-deletes an
  // unrelated, zero-gain resolved round they brewed.
  async function forceRecomputeViaAdminDelete(actingAdmin: Player, brewer: Player) {
    const { data: round, error } = await admin
      .from("rounds")
      .insert({
        room_id: brewer.roomId,
        started_by: brewer.googleSub,
        status: "resolved",
        brewer_id: brewer.googleSub,
        cups_made: 0,
        brewer_modifier_gain: 0,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    cleanup.trackRound(round!.id);
    const { error: delErr } = await actingAdmin.client.rpc("admin_delete_round", {
      p_round_id: round!.id,
      p_reason: "#395 recompute trigger",
    });
    expect(delErr).toBeNull();
  }

  async function makeAdmin(p: Player) {
    const { error } = await admin.from("players").update({ is_admin: true }).eq("id", p.googleSub);
    expect(error).toBeNull();
  }

  async function assertSuppressedGainStaysSuppressed(p1: Player, p2: Player) {
    expect(await liveModifier(p1)).toBe(0);

    await makeAdmin(p2);
    await forceRecomputeViaAdminDelete(p2, p1);

    // The suppressed round's 2 cups must not reappear in the cache...
    expect(await liveModifier(p1)).toBe(0);
    // ...nor in the breakdown, whose columns reconcile to the cache.
    const b = await breakdown(p1);
    expect(b).toEqual({ cups_made: 0, adjustments: 0, spell_effects: 0 });
    expect(b.cups_made + b.adjustments + b.spell_effects).toBe(await liveModifier(p1));
  }

  it("Drip Tray (highest_modifier, no_modifier_gain) brewer keeps zero gain after admin_delete_round recompute", async () => {
    const p1 = await signUp("sg-drip-1");
    const p2 = await signUp("sg-drip-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 8);
    await seedRoll(roundId, p2.googleSub, 5, 2);
    const instanceId = await forceHold(admin, p1.googleSub, "Drip Tray");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    const { error: castErr } = await admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: p1.googleSub,
      card_instance_id: instanceId,
      target_player_id: null,
      target_pending: false,
      effect_kind: "tea_maker_override",
      effect_params: { mode: "highest_modifier", no_modifier_gain: true },
    });
    expect(castErr).toBeNull();

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.no_modifier_gain).toBe(true);
    expect(out.cups_made).toBe(2);

    await assertSuppressedGainStaysSuppressed(p1, p2);
  });

  it("Eternal Steep (block_earned_modifier) warded brewer keeps zero gain after admin_delete_round recompute", async () => {
    const p1 = await signUp("sg-steep-1");
    const p2 = await signUp("sg-steep-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3);
    await seedRoll(roundId, p2.googleSub, 15);
    await seedActiveEffect(admin, cleanup, {
      roomId: p1.roomId,
      targetPlayerId: p1.googleSub,
      casterId: p2.googleSub,
      cardName: "Eternal Steep",
      effectKind: "ward",
      effectParams: { polarity: ["positive", "negative"], domain: ["modifier"], block_earned_modifier: true },
      roundsRemaining: null,
    });

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.no_modifier_gain).toBe(true);
    expect(out.cups_made).toBe(2);

    await assertSuppressedGainStaysSuppressed(p1, p2);
  });

  it("a normal brewer's gain is unchanged by the recompute and still shows in the breakdown", async () => {
    const p1 = await signUp("sg-normal-1");
    const p2 = await signUp("sg-normal-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3);
    await seedRoll(roundId, p2.googleSub, 15);

    const out = await resolve(p1.client, roundId);
    expect(out.brewer_id).toBe(p1.googleSub);
    expect(out.no_modifier_gain).toBe(false);
    expect(await liveModifier(p1)).toBe(2);

    await makeAdmin(p2);
    await forceRecomputeViaAdminDelete(p2, p1);

    expect(await liveModifier(p1)).toBe(2);
    expect(await breakdown(p1)).toEqual({ cups_made: 2, adjustments: 0, spell_effects: 0 });
  });
});
