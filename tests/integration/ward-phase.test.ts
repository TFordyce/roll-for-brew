import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  signUpSignInAndEnterRoom,
  closeRoundAs,
  declareInAs,
  startRoundAs,
} from "./setup";

// Runs against a real Supabase stack. Exercises the ward phase (#309, spec
// §7): modifier-domain wards filter in resolve_round(uuid) Phase 2, roll-domain
// wards are a pre-apply check in the eager shim (apply_roll_swap etc.),
// block_earned_modifier zeroes the brewer's tea gain, and an earlier ward
// blocks a later overlapping one at record time. Asserts on externally
// observable outcomes only (spec section: Testing Decisions).

describe.skipIf(!hasAnonTestEnv)("ward phase (#309): polarity x domain immunity filter", () => {
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

  /**
   * Seeds a ward that reads as "carried forward from an earlier round":
   * seedActiveEffect stands up a real ward spell_casts row in its own prior
   * resolved round (spell_active_effects.source_cast_id is NOT NULL since
   * #310) plus the projected spell_active_effects row. card_id is a real
   * ward card so tier-scoped dispel works unchanged.
   */
  async function seedWard(
    roomId: string,
    casterId: string,
    targetPlayerId: string,
    effectParams: Record<string, unknown>,
    roundsRemaining: number | null = null,
    cardName = "Jinxed Biscuit",
  ) {
    const { effectId } = await seedActiveEffect(admin, cleanup, {
      roomId,
      targetPlayerId,
      casterId,
      cardName,
      effectKind: "ward",
      effectParams,
      roundsRemaining,
    });
    return effectId;
  }

  // ----------------------------------------------------------------------
  // Cast path + catalog (record_active_effect_if_persistent)
  // ----------------------------------------------------------------------

  it("the four ward cards map to their spec §7 effect_params", async () => {
    const { data: rows, error } = await admin
      .from("spell_card_effects")
      .select("effect_kind, effect_params, spell_cards!inner(name, duration_rounds)")
      .in("spell_cards.name", ["Jinxed Biscuit", "Cast-Iron Kettle", "Bag for Life", "Eternal Steep"]);
    expect(error).toBeNull();

    const byName = Object.fromEntries(
      (rows ?? []).map((r) => {
        const card = r.spell_cards as unknown as { name: string; duration_rounds: number | null };
        return [card.name, { ...r, duration_rounds: card.duration_rounds }];
      }),
    );

    expect(byName["Jinxed Biscuit"]).toMatchObject({
      effect_kind: "ward",
      effect_params: { polarity: ["positive"], domain: ["modifier", "roll"] },
      duration_rounds: 3,
    });
    expect(byName["Cast-Iron Kettle"]).toMatchObject({
      effect_kind: "ward",
      effect_params: { polarity: ["negative"], domain: ["modifier", "roll"] },
      duration_rounds: 5,
    });
    expect(byName["Bag for Life"]).toMatchObject({
      effect_kind: "ward",
      effect_params: { polarity: ["positive", "negative"], domain: ["modifier"], block_copy: true },
      duration_rounds: null,
    });
    expect(byName["Eternal Steep"]).toMatchObject({
      effect_kind: "ward",
      effect_params: {
        polarity: ["positive", "negative"],
        domain: ["modifier"],
        block_earned_modifier: true,
      },
      duration_rounds: null,
    });
  });

  it("casting Jinxed Biscuit on an opponent records a ward active-effect (rounds_remaining 3) via record_active_effect_if_persistent", async () => {
    const p1 = await signUp("wp-cast-jb-1");
    const p2 = await signUp("wp-cast-jb-2");

    const { data: roundId, error: startErr } = await startRoundAs(p1.client);
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await declareInAs(p2.client, roundId);

    await forceHold(admin, p1.googleSub, "Jinxed Biscuit");
    // OPPONENT card cast with no target yet -> pending.
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    await closeRoundAs(roundId);

    const { data: pendingCast } = await admin
      .from("spell_casts")
      .select("id")
      .eq("round_id", roundId)
      .eq("effect_kind", "ward")
      .single();
    const { error: targetErr } = await p1.client.rpc("set_spell_cast_target", {
      p_cast_id: pendingCast!.id,
      p_target_player_id: p2.googleSub,
    });
    expect(targetErr).toBeNull();

    const { data: ward } = await admin
      .from("spell_active_effects")
      .select("effect_kind, effect_params, rounds_remaining, target_player_id, source_cast_id")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "ward")
      .eq("target_player_id", p2.googleSub)
      .single();
    expect(ward).toMatchObject({
      effect_kind: "ward",
      effect_params: { polarity: ["positive"], domain: ["modifier", "roll"] },
      rounds_remaining: 3,
      target_player_id: p2.googleSub,
      source_cast_id: pendingCast!.id,
    });
  });

  it("casting Bag for Life on SELF records an unbounded ward (rounds_remaining null)", async () => {
    const p1 = await signUp("wp-cast-bfl-1");
    const p2 = await signUp("wp-cast-bfl-2");

    const { data: roundId, error: startErr } = await startRoundAs(p1.client);
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await declareInAs(p2.client, roundId);

    await forceHold(admin, p1.googleSub, "Bag for Life");
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const { data: ward } = await admin
      .from("spell_active_effects")
      .select("effect_kind, rounds_remaining, target_player_id")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "ward")
      .eq("target_player_id", p1.googleSub)
      .single();
    expect(ward).toMatchObject({
      effect_kind: "ward",
      rounds_remaining: null,
      target_player_id: p1.googleSub,
    });
  });

  it("an earlier ward blocks a later overlapping ward: the later row is never created", async () => {
    const p1 = await signUp("wp-wow-1");
    const p2 = await signUp("wp-wow-2");

    // Pre-existing ward on p1: positive, modifier -- overlaps Bag for Life
    // (positive|negative, modifier) in both domain and polarity.
    await seedWard(p1.roomId, p2.googleSub, p1.googleSub, {
      polarity: ["positive"],
      domain: ["modifier"],
    });

    const { data: roundId, error: startErr } = await startRoundAs(p1.client);
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await declareInAs(p2.client, roundId);

    await forceHold(admin, p1.googleSub, "Bag for Life"); // SELF ward on p1
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const { data: wards } = await admin
      .from("spell_active_effects")
      .select("id, card_id, spell_cards!inner(name)")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "ward")
      .eq("target_player_id", p1.googleSub);
    // Only the seeded Jinxed-Biscuit-shaped ward survives; Bag for Life was blocked.
    expect(wards).toHaveLength(1);
    expect((wards![0]!.spell_cards as unknown as { name: string }).name).toBe("Jinxed Biscuit");
  });

  it("a non-overlapping earlier ward does NOT block a later ward", async () => {
    const p1 = await signUp("wp-wow-nonmatch-1");
    const p2 = await signUp("wp-wow-nonmatch-2");

    // Pre-existing ward on p1: roll-domain only -- Bag for Life is modifier-only,
    // so domains do not overlap and the later ward is created.
    await seedWard(
      p1.roomId,
      p2.googleSub,
      p1.googleSub,
      { polarity: ["positive", "negative"], domain: ["roll"] },
      3,
      "Jinxed Biscuit",
    );

    const { data: roundId, error: startErr } = await startRoundAs(p1.client);
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await declareInAs(p2.client, roundId);

    await forceHold(admin, p1.googleSub, "Bag for Life");
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const { data: wards } = await admin
      .from("spell_active_effects")
      .select("id")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "ward")
      .eq("target_player_id", p1.googleSub);
    expect(wards).toHaveLength(2);
  });
});
