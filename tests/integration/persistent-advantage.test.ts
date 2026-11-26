import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Exercises migration
// 0097_persistent_advantage.sql (issue #320, Tier A primitive 4 of the
// effect-application rebuild #302 / ADR 0005): Prophe-Tea's "roll every round
// with advantage for the rest of the day" as an unbounded advantage
// spell_active_effects projection row, applied by the eager shim (submit_roll)
// and traced by resolve_round Phase 3. Asserts externally observable outcomes
// only (spec: Testing Decisions).

describe.skipIf(!hasAnonTestEnv)("persistent advantage — Prophe-Tea (issue #320)", () => {
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

  // -----------------------------------------------------------------------
  // End-to-end: the real cast RPC + the real eager shim, across rounds.
  // -----------------------------------------------------------------------

  it("is un-benched and casting it promotes an unbounded advantage active effect", async () => {
    const caster = await signUp("prophe-cast");
    const other = await signUp("prophe-cast-other");

    // Un-benched: a live in_deck instance exists.
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "Prophe-Tea")
      .single();
    expect(inst!.location).toBe("in_deck");

    const instanceId = await forceHold(admin, caster.googleSub, "Prophe-Tea");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castErr } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
    });
    expect(castErr).toBeNull();
    expect(castId).toBeTruthy();

    // The held instance is consumed.
    const { data: after } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("id", instanceId)
      .single();
    expect(after!.location).toBe("in_deck");
    expect(after!.held_by_player).toBeNull();

    // A CASTER-targeted advantage cast row exists this round...
    const { data: casts } = await admin
      .from("spell_casts")
      .select("effect_kind, target_player_id")
      .eq("round_id", roundId);
    expect(casts).toContainEqual({ effect_kind: "advantage", target_player_id: caster.googleSub });

    // ...and it promoted an UNBOUNDED (rounds_remaining null) advantage
    // projection row on the caster.
    const { data: effects } = await admin
      .from("spell_active_effects")
      .select("effect_kind, target_player_id, rounds_remaining, effect_params")
      .eq("caster_id", caster.googleSub)
      .eq("effect_kind", "advantage");
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      effect_kind: "advantage",
      target_player_id: caster.googleSub,
      rounds_remaining: null,
    });
  });
});
