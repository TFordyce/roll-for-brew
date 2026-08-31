import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, forceHold, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises
// 0049_persist_discarded_advantage_disadvantage_roll.sql (issue #164): the
// second d20 rolled to resolve advantage/disadvantage used to be thrown
// away — submit_roll/submit_roll_as now persist it to rolls.discarded_value
// so the UI can later show it struck-through next to the kept roll.
describe.skipIf(!hasAnonTestEnv)("discarded advantage/disadvantage roll (issue #164)", () => {
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

  it("persists the discarded roll when disadvantage applies, and it's the losing side of the two d20s", async () => {
    const [caster, target] = await Promise.all([
      signUp("discard-disadv-caster"),
      signUp("discard-disadv-target"),
    ]);
    await forceHold(admin, caster.googleSub, "Slipped Spoon");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    // Slipped Spoon: target gets disadvantage, caster gets a 1d4 bonus.
    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: target.googleSub,
    });
    expect(castError).toBeNull();

    await caster.client.rpc("close_round", { p_round_id: roundId });

    const { error: targetRollError } = await target.client.rpc("submit_roll", { p_round_id: roundId });
    expect(targetRollError).toBeNull();

    const { data: targetRoll, error: readError } = await admin
      .from("rolls")
      .select("value, discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", target.googleSub)
      .single();
    expect(readError).toBeNull();

    // Disadvantage keeps the lower of the two d20s.
    expect(targetRoll!.discarded_value).not.toBeNull();
    expect(targetRoll!.discarded_value).toBeGreaterThanOrEqual(1);
    expect(targetRoll!.discarded_value).toBeLessThanOrEqual(20);
    expect(targetRoll!.value).toBeLessThanOrEqual(targetRoll!.discarded_value as number);

    // The caster rolled with no advantage/disadvantage this round — nothing
    // to discard.
    const { error: casterRollError } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
    expect(casterRollError).toBeNull();

    const { data: casterRoll, error: casterReadError } = await admin
      .from("rolls")
      .select("discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", caster.googleSub)
      .single();
    expect(casterReadError).toBeNull();
    expect(casterRoll!.discarded_value).toBeNull();
  });

  it("persists the discarded roll when advantage applies, and it's the losing side of the two d20s", async () => {
    const [caster, other] = await Promise.all([
      signUp("discard-adv-caster"),
      signUp("discard-adv-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Sugar Rush");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    // Sugar Rush: self-targeted, grants the caster advantage.
    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    const { error: closeError } = await caster.client.rpc("close_round", { p_round_id: roundId });
    expect(closeError).toBeNull();

    const { error: rollError } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
    expect(rollError).toBeNull();

    const { data: roll, error: readError } = await admin
      .from("rolls")
      .select("value, discarded_value")
      .eq("round_id", roundId)
      .eq("player_id", caster.googleSub)
      .single();
    expect(readError).toBeNull();

    // Advantage keeps the higher of the two d20s.
    expect(roll!.discarded_value).not.toBeNull();
    expect(roll!.discarded_value).toBeGreaterThanOrEqual(1);
    expect(roll!.discarded_value).toBeLessThanOrEqual(20);
    expect(roll!.value).toBeGreaterThanOrEqual(roll!.discarded_value as number);
  });

  it("surfaces discarded_value through get_current_layer_rolls_if_complete (issue #167, migration 0051)", async () => {
    const [caster, other] = await Promise.all([
      signUp("discard-rpc-caster"),
      signUp("discard-rpc-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Sugar Rush");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });

    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
    });
    expect(castError).toBeNull();

    await caster.client.rpc("close_round", { p_round_id: roundId });

    const { error: casterRollError } = await caster.client.rpc("submit_roll", { p_round_id: roundId });
    expect(casterRollError).toBeNull();
    const { error: otherRollError } = await other.client.rpc("submit_roll", { p_round_id: roundId });
    expect(otherRollError).toBeNull();

    const { data: rows, error: rowsError } = await caster.client.rpc("get_current_layer_rolls_if_complete", {
      p_round_id: roundId,
    });
    expect(rowsError).toBeNull();

    const typedRows = rows as { player_id: string; value: number; discarded_value: number | null }[];
    const casterRow = typedRows.find((r) => r.player_id === caster.googleSub);
    const otherRow = typedRows.find((r) => r.player_id === other.googleSub);

    // Advantage keeps the higher of the two d20s for the caster; the other
    // player had no advantage/disadvantage this round.
    expect(casterRow?.discarded_value).not.toBeNull();
    expect(casterRow!.value).toBeGreaterThanOrEqual(casterRow!.discarded_value as number);
    expect(otherRow?.discarded_value).toBeNull();
  });

  // submit_roll_as (0029_admin_roll_as.sql) carries the exact same
  // advantage/disadvantage resolution block as submit_roll — the two are
  // kept in lockstep by convention (see 0031's own duplication of this
  // logic) — but exercising the admin-puppeting-a-Test-Room-player path has
  // no existing integration-test harness in this suite to build on, so it's
  // left uncovered here rather than hand-rolling untested setup code. The
  // two tests above already prove the shared resolution logic itself is
  // correct for both the advantage and disadvantage branches.
});
