import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byTarget,
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises Late
// Declare (issue #246, CONTEXT.md glossary entry from #256): declare_in_late
// and round_has_any_rolls (supabase/migrations/0068_declare_in_late.sql).
describe.skipIf(!hasAnonTestEnv)("declare_in_late (Late Declare, issue #246)", () => {
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

  it("lets a player join a closed round with no rolls yet", async () => {
    const [{ client: starterClient, googleSub: starterSub }, { client: otherClient, googleSub: otherSub }, { googleSub: lateSub, client: lateClient }] = await Promise.all([
      signUp("late-declare-starter"),
      signUp("late-declare-other"),
      signUp("late-declare-late"),
    ]);

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });
    await starterClient.rpc("close_round", { p_round_id: roundId });

    expect(await lateClient.rpc("round_has_any_rolls", { p_round_id: roundId })).toMatchObject({
      data: false,
      error: null,
    });

    const { error } = await lateClient.rpc("declare_in_late", { p_round_id: roundId });
    expect(error).toBeNull();

    const { data: participants } = await admin
      .from("round_participants")
      .select("player_id")
      .eq("round_id", roundId);
    expect(new Set(participants!.map((p) => p.player_id))).toEqual(
      new Set([starterSub, otherSub, lateSub]),
    );
  });

  it("is idempotent on repeat calls", async () => {
    const [{ client: starterClient }, { client: otherClient }, { client: lateClient, googleSub: lateSub }] = await Promise.all([
      signUp("late-declare-idempotent-starter"),
      signUp("late-declare-idempotent-other"),
      signUp("late-declare-idempotent-late"),
    ]);

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });
    await starterClient.rpc("close_round", { p_round_id: roundId });

    const first = await lateClient.rpc("declare_in_late", { p_round_id: roundId });
    expect(first.error).toBeNull();
    const second = await lateClient.rpc("declare_in_late", { p_round_id: roundId });
    expect(second.error).toBeNull();

    const { data: participants } = await admin
      .from("round_participants")
      .select("player_id")
      .eq("round_id", roundId)
      .eq("player_id", lateSub);
    expect(participants).toHaveLength(1);
  });

  it("fails once a roll has already landed for the round (RFB31)", async () => {
    const [{ client: starterClient }, { client: otherClient }, { client: lateClient }] = await Promise.all([
      signUp("late-declare-rolled-starter"),
      signUp("late-declare-rolled-other"),
      signUp("late-declare-rolled-late"),
    ]);

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });
    await starterClient.rpc("close_round", { p_round_id: roundId });
    await starterClient.rpc("submit_roll", { p_round_id: roundId });

    expect(await lateClient.rpc("round_has_any_rolls", { p_round_id: roundId })).toMatchObject({
      data: true,
      error: null,
    });

    const { error } = await lateClient.rpc("declare_in_late", { p_round_id: roundId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB31");
  });

  it("fails while the round is still open (declare_in is the right call there)", async () => {
    const [{ client: starterClient }, { client: lateClient }] = await Promise.all([
      signUp("late-declare-open-starter"),
      signUp("late-declare-open-late"),
    ]);

    const { data: roundId } = await starterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error } = await lateClient.rpc("declare_in_late", { p_round_id: roundId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB31");
  });

  it("lets a still-deferred opponent-targeted cast target a newly Late-Declared player", async () => {
    const [{ client: casterClient, googleSub: casterSub }, { client: otherClient }, { client: lateClient, googleSub: lateSub }] = await Promise.all([
      signUp("late-declare-retarget-caster"),
      signUp("late-declare-retarget-other"),
      signUp("late-declare-retarget-late"),
    ]);
    await forceHold(admin, casterSub, "Milky Brew");

    const { data: roundId } = await casterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await otherClient.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await casterClient.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    await casterClient.rpc("close_round", { p_round_id: roundId });

    const { error: lateError } = await lateClient.rpc("declare_in_late", { p_round_id: roundId });
    expect(lateError).toBeNull();

    const { error: targetError } = await casterClient.rpc("set_spell_cast_target", {
      p_cast_id: castId,
      p_target_player_id: lateSub,
    });
    expect(targetError).toBeNull();

    const { data: effects } = await casterClient.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
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

    const { data: roundId } = await casterClient.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await targetClient.rpc("declare_in", { p_round_id: roundId });

    const { data: castId } = await casterClient.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });

    await casterClient.rpc("close_round", { p_round_id: roundId });
    await casterClient.rpc("set_spell_cast_target", {
      p_cast_id: castId,
      p_target_player_id: targetSub,
    });

    const { error: lateError } = await lateClient.rpc("declare_in_late", { p_round_id: roundId });
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
