import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
  closeRoundAs,
  declareInAs,
  startRoundAs,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// player_settings table (supabase/migrations/
// 0008_player_settings_and_manual_rolls.sql) and the rolls read policy
// through real signed-in sessions (issue #22). Submitting a manual roll is
// the API's RollSubmission now (#552).
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
    const [starter, other] = await Promise.all([signUp(starterLabel), signUp(otherLabel)]);

    const { data: roundId } = await startRoundAs(starter.client);
    cleanup.trackRound(roundId as string);
    await declareInAs(other.client, roundId);
    await closeRoundAs(roundId);

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
    const [player, other] = await Promise.all([
      signUp("settings-guard-self"),
      signUp("settings-guard-other"),
    ]);

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

  it("hides a manual roll from other players until they've personally rolled, same as an in-app roll", async () => {
    const { starter, other, roundId } = await startCloseAndDeclare(
      "manual-hidden-starter",
      "manual-hidden-other",
    );

    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: starter.googleSub,
      value: 12,
      input_mode: "manual",
      modifier_snapshot: 0,
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
});
