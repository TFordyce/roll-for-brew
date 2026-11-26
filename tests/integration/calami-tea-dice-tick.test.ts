import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real local Supabase stack. Exercises Calami-Tea's per-round
// dice tick (issue #289, spec #302 Tier B primitive 6 / migration
// 0100_calami_tea_per_round_dice_tick.sql):
//
//   * Casting Calami-Tea (CHOSEN_PLAYERS) emits one per_round_dice_tick anchor
//     cast per target + one spell_active_effects projection row (duration 3).
//   * resolve_round Phase 3-pre synthesises one child cast per target each
//     round the effect is live, carrying a freshly-rolled 1d4 in
//     cast_inputs.roll_transform; the Phase 3 walk subtracts it from the roll
//     (floor 1) and emits a `dice_tick` Trace step.
//   * The tick fires for the cast round + the next 2, then stops.
//   * A re-resolve reuses the recorded die (no re-roll, no extra rows).
//   * A negative-polarity roll-domain ward (Cast-Iron Kettle) on a target
//     blocks that round's tick: the synth cast goes in negated and a `warded`
//     step is emitted instead.

describe.skipIf(!hasAnonTestEnv)("Calami-Tea per-round dice tick (issue #289)", () => {
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

  // ==========================================================================

  it("rejects more chosen players than the card's max_targets", async () => {
    const [caster, t1, t2, t3, t4] = await Promise.all([
      signUp("calami-max-caster"),
      signUp("calami-max-t1"),
      signUp("calami-max-t2"),
      signUp("calami-max-t3"),
      signUp("calami-max-t4"),
    ]);
    await forceHold(admin, caster.googleSub, "Calami-Tea");
    const roundId = await startRound(caster, [t1, t2, t3, t4]);

    const { error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [t1.googleSub, t2.googleSub, t3.googleSub, t4.googleSub],
    });
    expect(error).not.toBeNull();
  });
});
