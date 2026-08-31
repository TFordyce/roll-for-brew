import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, forceHold, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises issue
// #250's get_reaction_window_pending_players (0065): the full per-window
// breakdown of who's still eligible and hasn't passed/cast this poll
// round — the data the ribbon banner (ReactionBanner.tsx) names players
// from, rather than showing a generic "waiting" message.
describe.skipIf(!hasAnonTestEnv)("get_reaction_window_pending_players (issue #250)", () => {
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

  async function pendingPlayerIds(client: SupabaseClient, roundId: string): Promise<string[]> {
    const { data, error } = await client.rpc("get_reaction_window_pending_players", { p_round_id: roundId });
    if (error) throw error;
    return (data as { player_id: string }[]).map((row) => row.player_id).sort();
  }

  it("returns nothing when no reaction window is open", async () => {
    const [caster, other] = await Promise.all([
      signUp("pending-none-caster"),
      signUp("pending-none-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Six Sugars"); // Reaction, Self

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    expect(await pendingPlayerIds(caster.client, roundId as string)).toEqual([]);
  });

  it("lists every eligible holder who hasn't passed yet, and drops each as they pass", async () => {
    const [caster, other] = await Promise.all([
      signUp("pending-list-caster"),
      signUp("pending-list-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Six Sugars"); // Reaction, Self
    await forceHold(admin, other.googleSub, "Mug Shot"); // Reaction, Opponent

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await caster.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });

    expect(await pendingPlayerIds(caster.client, roundId as string)).toEqual(
      [caster.googleSub, other.googleSub].sort(),
    );

    const { error: passError } = await caster.client.rpc("pass_reaction_window", { p_round_id: roundId });
    expect(passError).toBeNull();

    expect(await pendingPlayerIds(other.client, roundId as string)).toEqual([other.googleSub]);
  });

  it("resets to the new poll round's eligible holders once a cast reopens the window", async () => {
    const [caster, other] = await Promise.all([
      signUp("pending-reopen-caster"),
      signUp("pending-reopen-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Six Sugars"); // Reaction, Self
    await forceHold(admin, other.googleSub, "Mug Shot"); // Reaction, Opponent

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await caster.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });

    // The other player passes this poll round first...
    const { error: passError } = await other.client.rpc("pass_reaction_window", { p_round_id: roundId });
    expect(passError).toBeNull();
    expect(await pendingPlayerIds(caster.client, roundId as string)).toEqual([caster.googleSub]);

    // ...then the caster casts, spending their Reaction card and bumping the
    // poll round to give the other holder another chance to respond.
    const { error: castError } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();

    // The caster spent their only Reaction card (no longer eligible); the
    // other holder's earlier pass belonged to the prior poll round, so
    // they're pending again under the new one.
    expect(await pendingPlayerIds(other.client, roundId as string)).toEqual([other.googleSub]);
  });
});
