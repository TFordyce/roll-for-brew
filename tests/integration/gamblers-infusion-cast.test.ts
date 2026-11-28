import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, forceHold, hasAnonTestEnv, signUpSignInAndEnterRoom, declareInAs, startRoundAs } from "./setup";

// Gambler's Infusion (issue #319) at cast time: cast_spell_card copies the
// card's `condition` param onto the cast row. What the roll does with it is
// the API's RollSubmission now (#552).
describe.skipIf(!hasAnonTestEnv)("Gambler's Infusion cast (issue #319)", () => {
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

  it("cast_spell_card copies the condition param onto the cast row", async () => {
    const [caster, other] = await Promise.all([
      signUp("gambler-e2e-caster"),
      signUp("gambler-e2e-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Gambler's Infusion");

    const { data: roundId } = await startRoundAs(caster.client);
    cleanup.trackRound(roundId as string);
    await declareInAs(other.client, roundId);

    // The real path: hold the card, cast it (SELF), let cast_spell_card's
    // generic effect loop copy the spell_card_effects row.
    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    const { data: castRow } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, target_player_id, target_pending")
      .eq("round_id", roundId)
      .single();
    expect(castRow!.effect_kind).toBe("advantage");
    expect(castRow!.target_player_id).toBe(caster.googleSub);
    expect(castRow!.target_pending).toBe(false);
    expect((castRow!.effect_params as { condition?: Record<string, number> }).condition).toEqual({
      advantage_at_or_above: 15,
      disadvantage_at_or_below: 5,
    });
  });
});
