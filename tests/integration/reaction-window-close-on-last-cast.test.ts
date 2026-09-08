import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enforceStallTimeout } from "../../src/app/rounds/stallEnforcement";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
  stallTimeoutFuture as future,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises issue
// #387's fix (migration 0104): casting a Reaction card into the round's open
// reaction window (0021) burns the card back into the deck, so a cast can
// drop the eligible-holder count to zero. When it does, cast_reaction_spell_card
// must re-check count_eligible_reaction_holders and close the window itself
// (via the shared _rr_reopen_or_close_reaction_poll tail) instead of leaving
// it status = 'open' with nobody able to Pass — the same guard migration
// 0064 gave open_reaction_window / resolve_card_swap for issue #251.
describe.skipIf(!hasAnonTestEnv)("reaction window closes when a cast empties eligibility (issue #387)", () => {
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

  async function windowStatus(roundId: string): Promise<string> {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .select("status")
      .eq("round_id", roundId)
      .order("opened_at", { ascending: false })
      .limit(1)
      .single();
    if (error) throw error;
    return data.status as string;
  }

  async function openRoundWithWindow(
    caster: Awaited<ReturnType<typeof signUp>>,
    other: Awaited<ReturnType<typeof signUp>>,
  ): Promise<string> {
    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    const { data: openData, error: openError } = await caster.client.rpc("open_reaction_window", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(openError).toBeNull();
    expect((openData as { is_closed: boolean }[])[0]!.is_closed).toBe(false);
    return roundId as string;
  }

  it("closes the window when the sole eligible holder casts their Reaction card (generic effect-loop path)", async () => {
    const [caster, other] = await Promise.all([
      signUp("last-cast-zariel-caster"),
      signUp("last-cast-zariel-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Zariel's Fall"); // Reaction, TABLE, roll_flip

    const roundId = await openRoundWithWindow(caster, other);

    const { error: castError } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();

    expect(await windowStatus(roundId)).toBe("closed");
  });

  it("closes the window when the sole eligible holder casts a by-name early-return Reaction card", async () => {
    const [caster, other] = await Promise.all([
      signUp("last-cast-brutal-caster"),
      signUp("last-cast-brutal-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Brew-tal Swap"); // Reaction, OPPONENT, by-name early return

    const roundId = await openRoundWithWindow(caster, other);

    const { error: castError } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: other.googleSub,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();

    expect(await windowStatus(roundId)).toBe("closed");
  });

  it("enforceStallTimeout recovers a window some earlier code already stranded", async () => {
    const [caster, other] = await Promise.all([
      signUp("stall-recover-caster"),
      signUp("stall-recover-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Zariel's Fall"); // Reaction, TABLE, roll_flip

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await caster.client.rpc("submit_roll", { p_round_id: roundId });
    await other.client.rpc("submit_roll", { p_round_id: roundId });

    const { data: preRolls } = await admin
      .from("rolls")
      .select("player_id, value")
      .eq("round_id", roundId)
      .eq("layer", 0);
    const preByPlayer = new Map((preRolls as { player_id: string; value: number }[]).map((r) => [r.player_id, r.value]));

    await caster.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });
    await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });

    // Recreate the pre-0104 stranded shape: the cast (correctly) closed the
    // window under 0104, so re-open it by hand with nobody eligible to Pass.
    const { data: windowRow } = await admin
      .from("spell_reaction_windows")
      .select("id")
      .eq("round_id", roundId)
      .order("opened_at", { ascending: false })
      .limit(1)
      .single();
    await admin
      .from("spell_reaction_windows")
      .update({ status: "open", closed_at: null })
      .eq("id", (windowRow as { id: string }).id);

    const outcome = await enforceStallTimeout(caster.client, roundId as string, future);
    expect(outcome).toEqual({ action: "reactionWindowRecovered" });

    const { data: round } = await admin
      .from("rounds")
      .select("status, brewer_id")
      .eq("id", roundId)
      .single();
    expect(round!.status).toBe("resolved");
    expect(round!.brewer_id).toBeTruthy();

    const { data: postRolls } = await admin
      .from("rolls")
      .select("player_id, value")
      .eq("round_id", roundId)
      .eq("layer", 0);
    for (const r of postRolls as { player_id: string; value: number }[]) {
      expect(r.value).toBe(21 - preByPlayer.get(r.player_id)!);
    }
  });

  it("leaves the window open while another eligible Reaction-card holder remains", async () => {
    const [caster, other] = await Promise.all([
      signUp("last-cast-other-eligible-caster"),
      signUp("last-cast-other-eligible-other"),
    ]);
    await forceHold(admin, caster.googleSub, "Zariel's Fall"); // Reaction, TABLE
    await forceHold(admin, other.googleSub, "Mug Shot"); // Reaction, OPPONENT — still eligible after the cast

    const roundId = await openRoundWithWindow(caster, other);

    const { error: castError } = await caster.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_target_cast_id: null,
    });
    expect(castError).toBeNull();

    expect(await windowStatus(roundId)).toBe("open");
  });
});
