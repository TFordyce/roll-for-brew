import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// player_settings table and the submit_manual_roll RPC (supabase/migrations/
// 0008_player_settings_and_manual_rolls.sql) through real signed-in sessions,
// covering the acceptance criteria of issue #22: manual roll submission and
// rolls.input_mode recording, for each of the three roll_input_mode
// preferences (in_app_only / manual_only / both — the preference itself
// never gates which RPC a caller may invoke server-side; it's purely a
// client-side UI choice, so all three settings can call either RPC).
describe.skipIf(!hasAnonTestEnv)("manual roll entry + player_settings (issue #22)", () => {
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

  async function startCloseAndDeclare(starterLabel: string, otherLabel: string) {
    const starter = await signUp(starterLabel);
    const other = await signUp(otherLabel);

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await starter.client.rpc("close_round", { p_round_id: roundId });

    return { starter, other, roundId: roundId as string };
  }

  it("defaults a player's roll_input_mode to in_app_only when they have no settings row yet", async () => {
    const player = await signUp("settings-default");

    const { data, error } = await player.client
      .from("player_settings")
      .select("roll_input_mode")
      .eq("player_id", player.googleSub)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("lets a player set and read back their own roll_input_mode preference", async () => {
    const player = await signUp("settings-own");

    const { error: upsertError } = await player.client
      .from("player_settings")
      .upsert({ player_id: player.googleSub, roll_input_mode: "manual_only" });
    expect(upsertError).toBeNull();

    const { data, error } = await player.client
      .from("player_settings")
      .select("roll_input_mode")
      .eq("player_id", player.googleSub)
      .single();
    expect(error).toBeNull();
    expect(data!.roll_input_mode).toBe("manual_only");

    const { error: updateError } = await player.client
      .from("player_settings")
      .upsert({ player_id: player.googleSub, roll_input_mode: "both" });
    expect(updateError).toBeNull();

    const { data: updated, error: updatedError } = await player.client
      .from("player_settings")
      .select("roll_input_mode")
      .eq("player_id", player.googleSub)
      .single();
    expect(updatedError).toBeNull();
    expect(updated!.roll_input_mode).toBe("both");
  });

  it("rejects writing another player's roll_input_mode row", async () => {
    const player = await signUp("settings-guard-self");
    const other = await signUp("settings-guard-other");

    const { error } = await player.client
      .from("player_settings")
      .upsert({ player_id: other.googleSub, roll_input_mode: "manual_only" });
    expect(error).not.toBeNull();
  });

  it("rejects an out-of-range roll_input_mode value", async () => {
    const player = await signUp("settings-invalid");

    const { error } = await player.client
      .from("player_settings")
      .upsert({ player_id: player.googleSub, roll_input_mode: "bogus" });
    expect(error).not.toBeNull();
  });

  it("records a manual roll with input_mode = 'manual' and enforces the 1-20 range", async () => {
    const { starter, roundId } = await startCloseAndDeclare(
      "manual-roll-starter",
      "manual-roll-other",
    );

    const { error: tooLowError } = await starter.client.rpc("submit_manual_roll", {
      p_round_id: roundId,
      p_value: 0,
    });
    expect(tooLowError).not.toBeNull();

    const { error: tooHighError } = await starter.client.rpc("submit_manual_roll", {
      p_round_id: roundId,
      p_value: 21,
    });
    expect(tooHighError).not.toBeNull();

    const { error } = await starter.client.rpc("submit_manual_roll", {
      p_round_id: roundId,
      p_value: 17,
    });
    expect(error).toBeNull();

    const { data: row, error: rowError } = await starter.client
      .from("rolls")
      .select("value, input_mode")
      .eq("round_id", roundId)
      .eq("player_id", starter.googleSub)
      .single();
    expect(rowError).toBeNull();
    expect(row).toMatchObject({ value: 17, input_mode: "manual" });
  });

  it("hides a manual roll from other players until they've personally rolled, same as an in-app roll", async () => {
    const { starter, other, roundId } = await startCloseAndDeclare(
      "manual-hidden-starter",
      "manual-hidden-other",
    );

    const { error } = await starter.client.rpc("submit_manual_roll", {
      p_round_id: roundId,
      p_value: 12,
    });
    expect(error).toBeNull();

    const { data: peek, error: peekError } = await other.client
      .from("rolls")
      .select("player_id")
      .eq("round_id", roundId)
      .eq("player_id", starter.googleSub);
    expect(peekError).toBeNull();
    expect(peek).toEqual([]);
  });

  it("submit_manual_roll rejects a caller who is not a declared participant", async () => {
    const starter = await signUp("manual-guard-starter");
    const other = await signUp("manual-guard-other");
    const bystander = await signUp("manual-guard-bystander");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await starter.client.rpc("close_round", { p_round_id: roundId });

    const { error } = await bystander.client.rpc("submit_manual_roll", {
      p_round_id: roundId,
      p_value: 10,
    });
    expect(error).not.toBeNull();
  });

  // Covers the acceptance criterion "Integration test covering manual roll
  // submission and input_mode recording for all three preference settings"
  // directly: for each of in_app_only / manual_only / both, a player who has
  // set that preference submits a roll and rolls.input_mode records the
  // actual input method used — not the preference itself, since (per the
  // spec) 'both' has no locked-in mode and the preference never gates which
  // RPC a caller may invoke server-side.
  it.each([
    { preference: "in_app_only", submittedVia: "in_app" as const },
    { preference: "manual_only", submittedVia: "manual" as const },
    { preference: "both", submittedVia: "in_app" as const },
    { preference: "both", submittedVia: "manual" as const },
  ] as const)(
    "records input_mode='$submittedVia' for a player whose preference is '$preference'",
    async ({ preference, submittedVia }) => {
      const { starter, other, roundId } = await startCloseAndDeclare(
        `pref-${preference}-${submittedVia}-starter`,
        `pref-${preference}-${submittedVia}-other`,
      );

      const { error: settingsError } = await starter.client
        .from("player_settings")
        .upsert({ player_id: starter.googleSub, roll_input_mode: preference });
      expect(settingsError).toBeNull();

      const { error: submitError } =
        submittedVia === "manual"
          ? await starter.client.rpc("submit_manual_roll", { p_round_id: roundId, p_value: 13 })
          : await starter.client.rpc("submit_roll", { p_round_id: roundId });
      expect(submitError).toBeNull();

      const { error: otherSubmitError } = await other.client.rpc("submit_roll", {
        p_round_id: roundId,
      });
      expect(otherSubmitError).toBeNull();

      const { data: row, error: rowError } = await admin
        .from("rolls")
        .select("input_mode")
        .eq("round_id", roundId)
        .eq("player_id", starter.googleSub)
        .single();
      expect(rowError).toBeNull();
      expect(row!.input_mode).toBe(submittedVia);
    },
  );

  it("allows a mix of in-app and manual rolls to complete the same layer regardless of each player's preference", async () => {
    const { starter, other, roundId } = await startCloseAndDeclare(
      "mixed-input-starter",
      "mixed-input-other",
    );

    const { error: manualError } = await starter.client.rpc("submit_manual_roll", {
      p_round_id: roundId,
      p_value: 9,
    });
    expect(manualError).toBeNull();

    const { error: inAppError } = await other.client.rpc("submit_roll", { p_round_id: roundId });
    expect(inAppError).toBeNull();

    const { data: complete, error: completeError } = await starter.client.rpc(
      "get_layer0_rolls_if_complete",
      { p_round_id: roundId },
    );
    expect(completeError).toBeNull();
    expect(complete).toHaveLength(2);

    const { data: rows, error: rowsError } = await admin
      .from("rolls")
      .select("player_id, input_mode")
      .eq("round_id", roundId);
    expect(rowsError).toBeNull();

    const inputModeByPlayer = new Map((rows ?? []).map((r) => [r.player_id, r.input_mode]));
    expect(inputModeByPlayer.get(starter.googleSub)).toBe("manual");
    expect(inputModeByPlayer.get(other.googleSub)).toBe("in_app");
  });
});
