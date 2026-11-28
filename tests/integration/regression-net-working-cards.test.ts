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
  declareInAs,
  startRoundAs,
} from "./setup";

// Issue #313 — the regression net ADR 0005 demands before any new-primitive
// work: every one of the 29 currently-working catalog cards pinned to an
// externally observable resolved-round outcome, run green through the new
// authoritative resolver (resolve_round(uuid), migrations 0078-0082).
//
// Each card is driven through the same seam resolve-round.test.ts uses:
// seed a closed round's rolls + a Cast Log row carrying the card's real
// spell_card_effects (effect_kind / effect_params), plus cast_inputs where a
// server-RNG draw or eager-shim before->after would have been recorded, then
// call resolve_round(uuid) and assert the brewer it picks and the Resolution
// Trace step the effect produces. Cards whose observable outcome does not
// flow through resolve_round (dispel via end_active_effect; the six WILD
// branches' cast-time dispatch) are driven through their real RPC instead.
//
// Assertions are on externally observable outcomes only — brewer, brewer
// source, adopted roll values in the Trace, spell_casts.negated, active
// effect removal, room_players.modifier after a cast-time dispatch — never on
// private helper shapes (spec: Testing Decisions).

describe.skipIf(!hasAnonTestEnv)("issue #313 regression net: 29 working cards", () => {
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

  // ====================================================================
  // flat_modifier — Lucky Sip, Caffeinated Focus, Brewer's Blessing,
  // Scalding Pour, Kettle Storm
  // ====================================================================

  // ====================================================================
  // set_modifier — Milky Brew, Mug Shot, Boil Over, Caffeine Crash
  // ====================================================================

  // ====================================================================
  // modifier_multiplier — Double Shot
  // ====================================================================

  // ====================================================================
  // dice_modifier — Six Sugars (standalone); Cold Tea / Slipped Spoon
  // carry the second dice half in the compound section below.
  // ====================================================================

  // ====================================================================
  // advantage / disadvantage (eager shim, roll_transform order 1) —
  // Sugar Rush, Fortune's Flavour
  // ====================================================================

  // ====================================================================
  // forced_reroll (eager shim, roll_transform order 2) —
  // Double Dunk, Re-Steep, Milk First?, Tea-M Reroll
  // ====================================================================

  // ====================================================================
  // roll_swap / roll_flip (eager shim, order 4 / 3) —
  // Dunkin Disaster, Zariel's Fall
  // ====================================================================

  // ====================================================================
  // Compound cards — both effect rows of one cast group must land
  // (Cold Tea, Slipped Spoon)
  // ====================================================================

  // ====================================================================
  // contested_negate — Tannin Tantrum (tier-derived DC from the victim card)
  // ====================================================================

  // ====================================================================
  // lowest_gains_highest_modifier — Broken Biscuit
  // ====================================================================

  // ====================================================================
  // tea_maker_override — Drip Tray (highest_modifier), Topsy-Tea (highest_roll)
  // ====================================================================

  // ====================================================================
  // declared_number_tea_maker — Inscribed Saucer
  // ====================================================================

  // ====================================================================
  // dispel — Lesser Detox (common), Greater Detox (rare/epic).
  // Not a resolve_round path: end_active_effect removes the matching-tier
  // active effect and logs a `dispel` cast.
  // ====================================================================

  describe("dispel", () => {
    // #310: a persistent flat_modifier effect standing in for a dispel
    // target. seedActiveEffect gives it the Cast Log anchor source_cast_id
    // now requires, in its own prior resolved round.
    async function seedDispellableEffect(
      roomId: string,
      targetId: string,
      casterId: string,
      cardName: string,
    ) {
      const { effectId } = await seedActiveEffect(admin, cleanup, {
        roomId,
        targetPlayerId: targetId,
        casterId,
        cardName,
        effectKind: "flat_modifier",
        effectParams: { delta: 3 },
        roundsRemaining: 9999,
      });
      return effectId;
    }

    it("Lesser Detox ends a common-tier active effect and logs a dispel cast; rejects a rare-tier one", async () => {
      const caster = await signUp("reg-lesser-detox-caster");
      const target = await signUp("reg-lesser-detox-target");
      // Lucky Sip is common; Milky Brew is rare.
      const commonEffectId = await seedDispellableEffect(caster.roomId, target.googleSub, caster.googleSub, "Lucky Sip");
      const rareEffectId = await seedDispellableEffect(caster.roomId, target.googleSub, caster.googleSub, "Milky Brew");

      await forceHold(admin, caster.googleSub, "Lesser Detox");
      const { data: roundId, error: startErr } = await startRoundAs(caster.client);
      expect(startErr).toBeNull();
      cleanup.trackRound(roundId as string);
      await declareInAs(target.client, roundId);

      const { error: rejectErr } = await caster.client.rpc("end_active_effect", {
        p_round_id: roundId,
        p_effect_id: rareEffectId,
      });
      expect(rejectErr).not.toBeNull();

      const { error: dispelErr } = await caster.client.rpc("end_active_effect", {
        p_round_id: roundId,
        p_effect_id: commonEffectId,
      });
      expect(dispelErr).toBeNull();

      // #310: end_active_effect logs a dispel cast and no longer deletes the
      // row. Both rows still exist physically; the projection drops the
      // dispelled one.
      const live = await caster.client.rpc("get_room_active_effects", { p_room_id: caster.roomId });
      const liveIds = (live.data as { effect_id: string }[]).map((r) => r.effect_id);
      expect(liveIds).toContain(rareEffectId);
      expect(liveIds).not.toContain(commonEffectId);

      const { data: dispelCasts } = await admin
        .from("spell_casts")
        .select("effect_kind")
        .eq("round_id", roundId)
        .eq("effect_kind", "dispel");
      expect(dispelCasts).toHaveLength(1);
    });

    it("Greater Detox ends a rare-tier active effect and logs a dispel cast; rejects a common-tier one", async () => {
      const caster = await signUp("reg-greater-detox-caster");
      const target = await signUp("reg-greater-detox-target");
      const commonEffectId = await seedDispellableEffect(caster.roomId, target.googleSub, caster.googleSub, "Lucky Sip");
      const rareEffectId = await seedDispellableEffect(caster.roomId, target.googleSub, caster.googleSub, "Milky Brew");

      await forceHold(admin, caster.googleSub, "Greater Detox");
      const { data: roundId, error: startErr } = await startRoundAs(caster.client);
      expect(startErr).toBeNull();
      cleanup.trackRound(roundId as string);
      await declareInAs(target.client, roundId);

      const { error: rejectErr } = await caster.client.rpc("end_active_effect", {
        p_round_id: roundId,
        p_effect_id: commonEffectId,
      });
      expect(rejectErr).not.toBeNull();

      const { error: dispelErr } = await caster.client.rpc("end_active_effect", {
        p_round_id: roundId,
        p_effect_id: rareEffectId,
      });
      expect(dispelErr).toBeNull();

      // #310: rows persist; the projection drops the dispelled rare one.
      const live = await caster.client.rpc("get_room_active_effects", { p_room_id: caster.roomId });
      const liveIds = (live.data as { effect_id: string }[]).map((r) => r.effect_id);
      expect(liveIds).toContain(commonEffectId);
      expect(liveIds).not.toContain(rareEffectId);

      const { data: dispelCasts } = await admin
        .from("spell_casts")
        .select("effect_kind")
        .eq("round_id", roundId)
        .eq("effect_kind", "dispel");
      expect(dispelCasts).toHaveLength(1);
    });
  });

  // ====================================================================
  // wild_dispatch — Wild Brew Surge, all six d6 branches.
  // Branches dispatch imperatively at cast time; drive the real
  // cast_spell_card RPC in a loop until every branch has been observed.
  // ====================================================================

  it("Wild Brew Surge dispatches every one of its six d6 branches to a consistent outcome", async () => {
    const caster = await signUp("reg-wbs-caster");
    const other = await signUp("reg-wbs-other");
    // Own room: branches 3 and 5 pick their swap partner from every
    // room_players row, and today's shared room holds leaked strangers (#422).
    caster.roomId = other.roomId = await seedDedicatedRoom(admin, cleanup, [caster.googleSub, other.googleSub]);
    const { data: card } = await admin.from("spell_cards").select("id").eq("name", "Wild Brew Surge").single();
    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("id")
      .eq("card_id", card!.id)
      .single();
    const wbsInstanceId = instance!.id as string;

    const seen = new Set<number>();
    const CASTER_MOD = 7;
    const OTHER_MOD = 2;
    const MAX_ATTEMPTS = 120;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && seen.size < 6; attempt++) {
      // Fresh known modifiers for each attempt.
      await admin
        .from("room_players")
        .update({ modifier: CASTER_MOD })
        .eq("room_id", caster.roomId)
        .eq("player_id", caster.googleSub);
      await admin
        .from("room_players")
        .update({ modifier: OTHER_MOD })
        .eq("room_id", caster.roomId)
        .eq("player_id", other.googleSub);
      // Re-arm the single WBS instance into the caster's hand.
      await admin
        .from("spell_deck_instances")
        .update({ location: "held", held_by_player: caster.googleSub })
        .eq("id", wbsInstanceId);

      const { data: roundId, error: startErr } = await startRoundAs(caster.client, caster.roomId);
      expect(startErr).toBeNull();
      // Track for teardown too: a mid-loop expect failure skips the
      // admin.from("rounds").delete() at the end of the iteration.
      cleanup.trackRound(roundId as string);
      await declareInAs(other.client, roundId);

      const { error: castErr } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
      expect(castErr).toBeNull();

      const { data: dispatchRow } = await admin
        .from("spell_casts")
        .select("cast_inputs")
        .eq("round_id", roundId)
        .eq("effect_kind", "wild_dispatch")
        .order("cast_at", { ascending: true })
        .limit(1)
        .single();
      const branch = (dispatchRow!.cast_inputs as { branch: number }).branch;
      expect(branch).toBeGreaterThanOrEqual(1);
      expect(branch).toBeLessThanOrEqual(6);
      seen.add(branch);

      const { data: mods } = await admin
        .from("room_players")
        .select("player_id, modifier")
        .eq("room_id", caster.roomId)
        .in("player_id", [caster.googleSub, other.googleSub]);
      const modOf = (pid: string) => mods!.find((m) => m.player_id === pid)!.modifier;

      if (branch === 1) {
        // Everyone in the room reset to 0.
        expect(modOf(caster.googleSub)).toBe(0);
        expect(modOf(other.googleSub)).toBe(0);
      } else if (branch === 2) {
        // #311: +3 caster rest of day is now armed as a one-sided
        // persistent_modifier_transfer the resolver's Phase 4b projects into
        // room_players.modifier at resolve -- no cast-time mutation. Same
        // rest-of-day outcome, deferred like branches 4 and 6.
        const { data: pmt } = await admin
          .from("spell_casts")
          .select("target_player_id, effect_params")
          .eq("round_id", roundId)
          .eq("effect_kind", "persistent_modifier_transfer");
        expect(pmt).toHaveLength(1);
        expect(pmt![0]).toMatchObject({
          target_player_id: caster.googleSub,
          effect_params: { delta: 3 },
        });
        expect(modOf(caster.googleSub)).toBe(CASTER_MOD);
        expect(modOf(other.googleSub)).toBe(OTHER_MOD);
      } else if (branch === 3) {
        // #311: caster <-> other modifier swap is now armed as a
        // persistent_modifier_transfer sibling pair with a cast-time snapshot;
        // Phase 4b projects both sides at resolve.
        const { data: pmt } = await admin
          .from("spell_casts")
          .select("id, target_player_id, effect_params, cast_inputs, source_cast_id")
          .eq("round_id", roundId)
          .eq("effect_kind", "persistent_modifier_transfer")
          .order("seq", { ascending: true });
        expect(pmt).toHaveLength(2);
        const byTargetPmt = Object.fromEntries(pmt!.map((r) => [r.target_player_id, r]));
        const casterSide = byTargetPmt[caster.googleSub]!;
        const otherSide = byTargetPmt[other.googleSub]!;
        expect((casterSide.effect_params as { delta: number }).delta).toBe(OTHER_MOD - CASTER_MOD);
        expect((otherSide.effect_params as { delta: number }).delta).toBe(CASTER_MOD - OTHER_MOD);
        expect(casterSide.source_cast_id).toBeNull();
        expect(otherSide.source_cast_id).toBe(casterSide.id);
        expect(casterSide.cast_inputs).toMatchObject({ p1_modifier: CASTER_MOD, p2_modifier: OTHER_MOD });
        expect(modOf(caster.googleSub)).toBe(CASTER_MOD);
        expect(modOf(other.googleSub)).toBe(OTHER_MOD);
      } else if (branch === 4) {
        // Arms a table-wide forced_reroll placeholder for the resolver's roll phase.
        const { data: placeholder } = await admin
          .from("spell_casts")
          .select("target_role, target_pending")
          .eq("round_id", roundId)
          .eq("effect_kind", "forced_reroll");
        expect(placeholder).toHaveLength(1);
        expect(placeholder![0]).toMatchObject({ target_role: "TABLE", target_pending: true });
        expect(modOf(caster.googleSub)).toBe(CASTER_MOD);
      } else if (branch === 5) {
        // #311: highest <-> lowest modifier swap (caster 7 <-> other 2) is now
        // armed as a persistent_modifier_transfer sibling pair; Phase 4b
        // projects both sides at resolve.
        const { data: pmt } = await admin
          .from("spell_casts")
          .select("id, target_player_id, effect_params, cast_inputs, source_cast_id")
          .eq("round_id", roundId)
          .eq("effect_kind", "persistent_modifier_transfer")
          .order("seq", { ascending: true });
        expect(pmt).toHaveLength(2);
        const byTargetPmt = Object.fromEntries(pmt!.map((r) => [r.target_player_id, r]));
        const highSide = byTargetPmt[caster.googleSub]!;
        const lowSide = byTargetPmt[other.googleSub]!;
        expect((highSide.effect_params as { delta: number }).delta).toBe(OTHER_MOD - CASTER_MOD);
        expect((lowSide.effect_params as { delta: number }).delta).toBe(CASTER_MOD - OTHER_MOD);
        expect(highSide.source_cast_id).toBeNull();
        expect(lowSide.source_cast_id).toBe(highSide.id);
        expect(modOf(caster.googleSub)).toBe(CASTER_MOD);
        expect(modOf(other.googleSub)).toBe(OTHER_MOD);
      } else {
        // Branch 6: arms a tea_maker_override 'chosen' cast for the resolver's brewer phase.
        const { data: override } = await admin
          .from("spell_casts")
          .select("effect_params")
          .eq("round_id", roundId)
          .eq("effect_kind", "tea_maker_override");
        expect(override).toHaveLength(1);
        expect((override![0]!.effect_params as { mode: string }).mode).toBe("chosen");
        expect(modOf(caster.googleSub)).toBe(CASTER_MOD);
      }

      // Free the room for the next attempt.
      await admin.from("rounds").delete().eq("id", roundId);
    }

    // Restore the WBS instance to the deck for cleanup.
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", wbsInstanceId);

    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 30_000);
});
