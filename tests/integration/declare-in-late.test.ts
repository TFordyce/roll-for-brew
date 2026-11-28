import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byTarget,
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  roundModifierEffects,
  signUpSignInAndEnterRoom,
  closeRoundAs,
  declareInAs,
  startRoundAs,
} from "./setup";

// Late Declare (issue #246) against the casting SQL: how a deferred cast's
// target sees a player who joins after close. Late Declare itself is the
// API's (#552); declareInAs writes the same participant row.
describe.skipIf(!hasAnonTestEnv)("Late Declare and deferred targets (issue #246)", () => {
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

  it("lets a still-deferred opponent-targeted cast target a newly Late-Declared player", async () => {
    const [{ client: casterClient, googleSub: casterSub }, { client: otherClient }, { client: lateClient, googleSub: lateSub }] = await Promise.all([
      signUp("late-declare-retarget-caster"),
      signUp("late-declare-retarget-other"),
      signUp("late-declare-retarget-late"),
    ]);
    await forceHold(admin, casterSub, "Milky Brew");

    const { data: roundId } = await startRoundAs(casterClient);
    cleanup.trackRound(roundId as string);
    await declareInAs(otherClient, roundId);

    const { data: castId, error: castError } = await casterClient.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    await closeRoundAs(roundId);

    const { error: lateError } = await declareInAs(lateClient, roundId);
    expect(lateError).toBeNull();

    const { error: targetError } = await casterClient.rpc("set_spell_cast_target", {
      p_cast_id: castId,
      p_target_player_id: lateSub,
    });
    expect(targetError).toBeNull();

    const { data: effects } = await roundModifierEffects(admin, casterClient, roundId);
    expect(byTarget(effects as { target_player_id: string }[], lateSub)).toEqual([
      {
        target_player_id: lateSub,
        effect_kind: "set_modifier",
        effect_params: { value: 0 },
        resolved_value: null,
        card_name: "Milky Brew",
        caster_player_id: casterSub,
      },
    ]);
  });

  it("leaves an already-targeted cast unaffected by a later Late Declare", async () => {
    const [{ client: casterClient, googleSub: casterSub }, { client: targetClient, googleSub: targetSub }, { client: lateClient, googleSub: lateSub }] = await Promise.all([
      signUp("late-declare-no-retarget-caster"),
      signUp("late-declare-no-retarget-target"),
      signUp("late-declare-no-retarget-late"),
    ]);
    await forceHold(admin, casterSub, "Milky Brew");

    const { data: roundId } = await startRoundAs(casterClient);
    cleanup.trackRound(roundId as string);
    await declareInAs(targetClient, roundId);

    const { data: castId } = await casterClient.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });

    await closeRoundAs(roundId);
    await casterClient.rpc("set_spell_cast_target", {
      p_cast_id: castId,
      p_target_player_id: targetSub,
    });

    const { error: lateError } = await declareInAs(lateClient, roundId);
    expect(lateError).toBeNull();

    const { data: cast } = await admin
      .from("spell_casts")
      .select("target_player_id, target_pending")
      .eq("id", castId)
      .single();
    expect(cast).toEqual({ target_player_id: targetSub, target_pending: false });
    expect(cast!.target_player_id).not.toBe(lateSub);
  });
});
