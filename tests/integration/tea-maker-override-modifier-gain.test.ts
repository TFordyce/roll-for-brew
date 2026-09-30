import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #425 (spec #401 F1): the resolver's
// yes/no "no modifier gain" becomes a `modifier_gain` number -- null means the
// normal cups_made, 0 means none, anything else is used as given -- carried
// from resolve_round(uuid) through finalize_layer into the 4-arg
// resolve_round write and rounds.brewer_modifier_gain. The tea_maker_override
// mode is a closed set; an unknown mode is rejected.
describe.skipIf(!hasAnonTestEnv)("tea-maker override modifier gain (#425)", () => {
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

  type ResolveOut = {
    outcome: string;
    brewer_id: string | null;
    brewer_source: string | null;
    cups_made: number;
    modifier_gain: number | null;
    no_modifier_gain: boolean;
  };

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

  // A tea_maker_override cast recorded straight into the Cast Log, the way
  // the #395 tests seed Drip Tray: no catalog card carries the new
  // modifier_gain parameter yet (the card slices add them).
  async function seedOverrideCast(
    roundId: string,
    caster: Player,
    effectParams: Record<string, unknown>,
    targetPlayerId: string | null = null,
  ) {
    const instanceId = await forceHold(admin, caster.googleSub, "Drip Tray");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    return admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: caster.googleSub,
      card_instance_id: instanceId,
      target_player_id: targetPlayerId,
      target_pending: false,
      effect_kind: "tea_maker_override",
      effect_params: effectParams,
    });
  }

  async function resolve(client: SupabaseClient, roundId: string) {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOut;
  }

  async function finalize(client: SupabaseClient, roundId: string) {
    const { error: wErr } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" });
    expect(wErr).toBeNull();
    const { data, error } = await client.rpc("finalize_layer", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as { outcome: string; brewer_id: string };
  }

  async function roundGain(roundId: string) {
    const { data, error } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made, brewer_modifier_gain")
      .eq("id", roundId)
      .single();
    expect(error).toBeNull();
    return data!;
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

  it("a default-lowest brewer resolves with a null modifier gain and finalize_layer commits cups_made", async () => {
    const p1 = await signUp("mg-default-1");
    const p2 = await signUp("mg-default-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3);
    await seedRoll(roundId, p2.googleSub, 15);

    const out = await resolve(p1.client, roundId);
    expect(out).toMatchObject({ outcome: "brewer", brewer_id: p1.googleSub, cups_made: 2, modifier_gain: null });
    expect(out.no_modifier_gain).toBe(false);

    const fin = await finalize(p1.client, roundId);
    expect(fin).toMatchObject({ outcome: "brewer", brewer_id: p1.googleSub });
    expect(await roundGain(roundId)).toMatchObject({ status: "resolved", cups_made: 2, brewer_modifier_gain: 2 });
    expect(await liveModifier(p1)).toBe(2);
  });

  it("a legacy no_modifier_gain override (Drip Tray) resolves with modifier gain 0", async () => {
    const p1 = await signUp("mg-drip-1");
    const p2 = await signUp("mg-drip-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 5, 8);
    await seedRoll(roundId, p2.googleSub, 5, 2);
    const { error } = await seedOverrideCast(roundId, p1, { mode: "highest_modifier", no_modifier_gain: true });
    expect(error).toBeNull();

    const out = await resolve(p1.client, roundId);
    expect(out).toMatchObject({ brewer_id: p1.googleSub, modifier_gain: 0, no_modifier_gain: true });

    await finalize(p1.client, roundId);
    expect(await roundGain(roundId)).toMatchObject({ cups_made: 2, brewer_modifier_gain: 0 });
    expect(await liveModifier(p1)).toBe(0);
  });

  it("an override's modifier_gain is used as given and finalize_layer commits it to brewer_modifier_gain", async () => {
    const p1 = await signUp("mg-given-1");
    const p2 = await signUp("mg-given-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3);
    await seedRoll(roundId, p2.googleSub, 15);
    // Chosen override on the high roller with double the usual gain (the
    // Loaf of Lipton shape: 2 * cups_made).
    const { error } = await seedOverrideCast(roundId, p1, { mode: "chosen", modifier_gain: 4 }, p2.googleSub);
    expect(error).toBeNull();

    const out = await resolve(p1.client, roundId);
    expect(out).toMatchObject({
      brewer_id: p2.googleSub,
      brewer_source: "tea_maker_override:chosen",
      cups_made: 2,
      modifier_gain: 4,
      no_modifier_gain: false,
    });

    await finalize(p1.client, roundId);
    expect(await roundGain(roundId)).toMatchObject({
      status: "resolved",
      brewer_id: p2.googleSub,
      cups_made: 2,
      brewer_modifier_gain: 4,
    });
    expect(await liveModifier(p2)).toBe(4);
    expect(await liveModifier(p1)).toBe(0);
  });

  it("the 4-arg resolve_round write takes a modifier gain number: null is cups_made, 0 is none, else as given", async () => {
    const cases: [label: string, gain: number | null, expected: number][] = [
      ["null", null, 2],
      ["zero", 0, 0],
      ["given", 6, 6],
    ];
    for (const [label, gain, expected] of cases) {
      const p1 = await signUp(`mg-write-${label}-1`);
      const p2 = await signUp(`mg-write-${label}-2`);
      const roundId = await openAndCloseRound(p1, [p2]);
      await seedRoll(roundId, p1.googleSub, 3);
      await seedRoll(roundId, p2.googleSub, 15);

      const { error } = await p1.client.rpc("resolve_round", {
        p_round_id: roundId,
        p_brewer_id: p1.googleSub,
        p_cups_made: 2,
        p_modifier_gain: gain,
      });
      expect(error).toBeNull();
      expect(await roundGain(roundId)).toMatchObject({ status: "resolved", brewer_modifier_gain: expected });
      expect(await liveModifier(p1)).toBe(expected);
    }
  });

  it("the boolean no-modifier-gain write stays as a compat alias", async () => {
    const p1 = await signUp("mg-alias-1");
    const p2 = await signUp("mg-alias-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3);
    await seedRoll(roundId, p2.googleSub, 15);

    const { error } = await p1.client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: p1.googleSub,
      p_cups_made: 2,
      p_no_modifier_gain: true,
    });
    expect(error).toBeNull();
    expect(await roundGain(roundId)).toMatchObject({ status: "resolved", brewer_modifier_gain: 0 });
    expect(await liveModifier(p1)).toBe(0);
  });

  it("rejects a tea_maker_override cast with an unknown or missing mode", async () => {
    const p1 = await signUp("mg-unknown-1");
    const p2 = await signUp("mg-unknown-2");
    const roundId = await openAndCloseRound(p1, [p2]);

    const bogus = await seedOverrideCast(roundId, p1, { mode: "lowest_modifier" });
    expect(bogus.error?.code).toBe("23514");

    const missing = await seedOverrideCast(roundId, p1, { no_modifier_gain: true });
    expect(missing.error?.code).toBe("23514");
  });

  it("accepts every mode in the closed set on a cast", async () => {
    const p1 = await signUp("mg-closed-1");
    const p2 = await signUp("mg-closed-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    for (const mode of ["highest_modifier", "highest_roll", "chosen", "prev_round_highest", "conditional_chosen"]) {
      const { error } = await seedOverrideCast(roundId, p1, { mode });
      expect(error).toBeNull();
    }
  });

  it("a reserved mode (no card slice yet) stays out of the override contest instead of failing the round", async () => {
    const p1 = await signUp("mg-reserved-1");
    const p2 = await signUp("mg-reserved-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await seedRoll(roundId, p1.googleSub, 3);
    await seedRoll(roundId, p2.googleSub, 15);
    const { error } = await seedOverrideCast(roundId, p1, { mode: "prev_round_highest", modifier_gain: 0 });
    expect(error).toBeNull();

    const out = await resolve(p1.client, roundId);
    expect(out).toMatchObject({ brewer_id: p1.googleSub, brewer_source: "default", modifier_gain: null });
  });

  it("rejects a catalog tea_maker_override effect with an unknown mode", async () => {
    const { data: card, error: cardErr } = await admin
      .from("spell_cards")
      .select("id")
      .eq("name", "Drip Tray")
      .single();
    expect(cardErr).toBeNull();

    const { data: inserted, error } = await admin
      .from("spell_card_effects")
      .insert({
        card_id: card!.id,
        target_role: "TABLE",
        effect_kind: "tea_maker_override",
        effect_params: { mode: "lowest_modifier" },
      })
      .select("id");
    // Never leave a stray catalog row behind on the shared stack.
    if (inserted?.length) {
      await admin.from("spell_card_effects").delete().in("id", inserted.map((r) => r.id));
    }
    expect(error?.code).toBe("23514");
  });
});
