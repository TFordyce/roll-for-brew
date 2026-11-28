import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
  closeRoundAs,
  declareInAs,
  startRoundAs,
} from "./setup";

// Runs against a real Supabase stack. Covers issue #316 -- Effect Invocation
// Group A (Saucerer's Apprentice / Genie in the Teapot / Brew-merang),
// migration 0093, on top of #307 / #308 (the recursive negate fixpoint) and
// #309 / #344 (ward). Assertions are on externally observable outcomes only:
// the emitted Resolution Trace, the brewer, and the resolver-written
// spell_casts.copied_cast_id / seized_by_cast_id caches.

describe.skipIf(!hasAnonTestEnv)("Effect Invocation -- Group A (issue #316)", () => {
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
    const { data: roundId, error } = await startRoundAs(starter.client);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await declareInAs(o.client, roundId);
      expect(dErr).toBeNull();
    }
    const { error: cErr } = await closeRoundAs(roundId);
    expect(cErr).toBeNull();
    return roundId as string;
  }

  /** Force-hold a donor card, return it to the deck, and return its instance id. */
  async function donorInstance(playerId: string, donorCard: string) {
    const instanceId = await forceHold(admin, playerId, donorCard);
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    return instanceId;
  }

  async function seedCast(
    roundId: string,
    casterId: string,
    instanceId: string,
    row: {
      effectKind: string | null;
      effectParams?: Record<string, unknown>;
      targetPlayerId: string | null;
      reactionWindowId?: string;
      castInputs?: Record<string, unknown> | null;
      parentCastId?: string;
      targetRole?: string;
    },
  ) {
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: casterId,
        card_instance_id: instanceId,
        target_player_id: row.targetPlayerId,
        target_pending: false,
        effect_kind: row.effectKind,
        effect_params: row.effectParams ?? {},
        reaction_window_id: row.reactionWindowId ?? null,
        cast_inputs: row.castInputs ?? null,
        parent_cast_id: row.parentCastId ?? null,
        target_role: row.targetRole ?? null,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  // ---------------------------------------------------------------------------
  // Genie in the Teapot -- invoke (RPC path)
  // ---------------------------------------------------------------------------

  it("names an in_deck non-Epic Action card, resolves it, and does not move the instance", async () => {
    const p1 = await signUp("ei-genie-1");
    const p2 = await signUp("ei-genie-2");

    const { data: roundId, error } = await startRoundAs(p1.client);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    // p2 must be a participant before Genie can target them pre-roll.
    const { error: dErr } = await declareInAs(p2.client, roundId);
    expect(dErr).toBeNull();

    await forceHold(admin, p1.googleSub, "Genie in the Teapot");
    // Genie names Cold Tea (Action, OPPONENT, flat_modifier -3), targeting p2.
    const { data: castId, error: castErr } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p2.googleSub,
      p_invoked_card_name: "Cold Tea",
    });
    expect(castErr).toBeNull();
    expect(castId).toBeTruthy();

    // every emitted row carries the invoked-card tag and Cold Tea's effects
    // (compound: TARGET flat_modifier -3 + CASTER dice_modifier 1d4).
    const { data: rows } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, target_player_id, cast_inputs")
      .eq("round_id", roundId)
      .eq("caster_id", p1.googleSub);
    expect(rows).toHaveLength(2);
    for (const r of rows!) {
      expect((r.cast_inputs as { invoked_card?: string }).invoked_card).toBe("Cold Tea");
    }
    const flat = rows!.find((r) => r.effect_kind === "flat_modifier")!;
    expect(flat.effect_params).toMatchObject({ delta: -3 });
    expect(flat.target_player_id).toBe(p2.googleSub);

    // Cold Tea's own instance was never moved (ethereal).
    const { data: coldTea } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "Cold Tea")
      .single();
    expect(coldTea!.location).toBe("in_deck");
  });

  it("two Genies naming the same card both resolve; the named instance never moves", async () => {
    const p1 = await signUp("ei-genie2-1");
    const p2 = await signUp("ei-genie2-2");
    const p3 = await signUp("ei-genie2-3");

    const { data: roundId } = await startRoundAs(p1.client);
    cleanup.trackRound(roundId as string);
    for (const o of [p2, p3]) {
      const { error: dErr } = await declareInAs(o.client, roundId);
      expect(dErr).toBeNull();
    }

    // p1 Genies Cold Tea onto p3. Casting returns the Genie instance to the
    // deck, so p2 can then hold it and Genie the same card.
    await forceHold(admin, p1.googleSub, "Genie in the Teapot");
    const { error: e1 } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p3.googleSub,
      p_invoked_card_name: "Cold Tea",
    });
    expect(e1).toBeNull();

    await forceHold(admin, p2.googleSub, "Genie in the Teapot");
    const { error: e2 } = await p2.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p3.googleSub,
      p_invoked_card_name: "Cold Tea",
    });
    expect(e2).toBeNull();

    // both Genies' flat_modifier rows are present
    const { data: p1rows } = await admin
      .from("spell_casts").select("effect_kind").eq("round_id", roundId).eq("caster_id", p1.googleSub);
    const { data: p2rows } = await admin
      .from("spell_casts").select("effect_kind").eq("round_id", roundId).eq("caster_id", p2.googleSub);
    expect(p1rows!.some((r) => r.effect_kind === "flat_modifier")).toBe(true);
    expect(p2rows!.some((r) => r.effect_kind === "flat_modifier")).toBe(true);

    // Cold Tea's instance was never moved by either Genie
    const { data: coldTea } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "Cold Tea")
      .single();
    expect(coldTea!.location).toBe("in_deck");
  });

  it("rejects a name whose sole edition instance is not in_deck (RFB50)", async () => {
    const p1 = await signUp("ei-genie-held-1");
    const p2 = await signUp("ei-genie-held-2");

    const { data: roundId } = await startRoundAs(p1.client);
    cleanup.trackRound(roundId as string);

    // Cold Tea is now held by p2 -> not nameable.
    await forceHold(admin, p2.googleSub, "Cold Tea");
    await forceHold(admin, p1.googleSub, "Genie in the Teapot");

    const { error } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p2.googleSub,
      p_invoked_card_name: "Cold Tea",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB50");
  });

  it("rejects naming an Epic card / Genie itself (RFB50)", async () => {
    const p1 = await signUp("ei-genie-epic-1");
    await signUp("ei-genie-epic-2");
    const { data: roundId } = await startRoundAs(p1.client);
    cleanup.trackRound(roundId as string);
    await forceHold(admin, p1.googleSub, "Genie in the Teapot");

    const { error } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_invoked_card_name: "Genie in the Teapot",
    });
    expect(error?.code).toBe("RFB50");
  });

  // ---------------------------------------------------------------------------
  // No meta-invocation (RPC path)
  // ---------------------------------------------------------------------------

  it("an invocation card cannot invoke another invocation card (RFB49)", async () => {
    const p1 = await signUp("ei-meta-1");
    const p2 = await signUp("ei-meta-2");
    const p3 = await signUp("ei-meta-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);

    // A real open reaction window so cast_reaction_spell_card runs.
    const { data: win, error: winErr } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "open" })
      .select("id")
      .single();
    expect(winErr).toBeNull();

    // p1 has a plain cast on the stack; p2 Brew-merangs it.
    const srcInst = await donorInstance(p1.googleSub, "Brewer's Blessing");
    const srcCast = await seedCast(roundId, p1.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p3.googleSub,
      reactionWindowId: win!.id,
      targetRole: "TARGET",
    });
    const bmInst = await donorInstance(p2.googleSub, "Brew-merang");
    const bmCast = await seedCast(roundId, p2.googleSub, bmInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win!.id,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { seized_cast_id: srcCast },
    });

    // p3 tries to Saucerer's-Apprentice-copy the Brew-merang -> RFB49.
    await forceHold(admin, p3.googleSub, "Saucerer's Apprentice");
    const { error } = await p3.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_cast_id: bmCast,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB49");
  });
});
