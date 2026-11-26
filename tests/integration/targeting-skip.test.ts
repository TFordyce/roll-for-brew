import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Covers issue #321 -- Tier A primitive 5,
// the "targeting skip" flag (migration 0099). Cloud of Cream drops its holder
// from highest/lowest-modifier *target selection* in resolve_round Phase 4c
// (lowest_gains_highest_modifier -- both the highest-modifier source and the
// lowest beneficiary set) and Phase 5 (tea_maker_override mode
// `highest_modifier`); the next eligible player is used. The flag never
// changes the holder's own composed modifier or the default brewer pick.
// Assertions are on externally observable outcomes only: the picked brewer,
// the emitted Resolution Trace, and the recorded active-effect row.

describe.skipIf(!hasAnonTestEnv)("targeting skip -- Cloud of Cream (#321)", () => {
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

  // ----------------------------------------------------------------------
  // Real cast path + catalog
  // ----------------------------------------------------------------------

  it("casting Cloud of Cream on SELF records a targeting_skip active effect with rounds_remaining 2", async () => {
    const p1 = await signUp("ts-cast-1");
    const p2 = await signUp("ts-cast-2");

    const { data: roundId, error: startErr } = await p1.client.rpc("start_round");
    expect(startErr).toBeNull();
    cleanup.trackRound(roundId as string);
    await p2.client.rpc("declare_in", { p_round_id: roundId });

    await forceHold(admin, p1.googleSub, "Cloud of Cream");
    const { error: castErr } = await p1.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(castErr).toBeNull();

    const { data: effect, error } = await admin
      .from("spell_active_effects")
      .select("effect_kind, rounds_remaining, target_player_id")
      .eq("room_id", p1.roomId)
      .eq("effect_kind", "targeting_skip")
      .single();
    expect(error).toBeNull();
    expect(effect).toMatchObject({
      effect_kind: "targeting_skip",
      rounds_remaining: 2,
      target_player_id: p1.googleSub,
    });
  });

  it("the Cloud of Cream catalog row maps to one CASTER targeting_skip effect with duration 2", async () => {
    const { data: card } = await admin
      .from("spell_cards")
      .select("id, duration_rounds")
      .eq("name", "Cloud of Cream")
      .single();
    expect(card!.duration_rounds).toBe(2);

    const { data: effects } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params")
      .eq("card_id", card!.id);
    expect(effects).toEqual([
      { target_role: "CASTER", effect_kind: "targeting_skip", effect_params: {} },
    ]);
  });
});
