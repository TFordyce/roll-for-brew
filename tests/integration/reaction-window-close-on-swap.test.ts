import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, forceHold, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises issue
// #251's fix: resolving a keep-or-swap decision (0018) that drops the
// resolving player out of Reaction-card eligibility must re-check the
// round's open reaction window (0021) and close it if nobody eligible
// remains — resolve_card_swap (0064) is the RPC under test.
describe.skipIf(!hasAnonTestEnv)("reaction window closes when a keep-or-swap decision empties eligibility (issue #251)", () => {
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

  /** Parks a specific catalog card as the given player's pending_swap draw. */
  async function forcePendingSwap(playerId: string, cardName: string): Promise<void> {
    const { data: card, error: cardError } = await admin.from("spell_cards").select("id").eq("name", cardName).single();
    if (cardError) throw cardError;

    const { data: instance, error: instanceError } = await admin
      .from("spell_deck_instances")
      .select("id")
      .eq("card_id", card.id)
      .single();
    if (instanceError) throw instanceError;

    const { error: updateError } = await admin
      .from("spell_deck_instances")
      .update({ location: "pending_swap", held_by_player: playerId })
      .eq("id", instance.id);
    if (updateError) throw updateError;
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

  it("closes the window and hands back the round id when the sole eligible holder swaps their Reaction card away", async () => {
    const caster = await signUp("swap-close-caster");
    const other = await signUp("swap-close-other");
    await forceHold(admin, caster.googleSub, "Six Sugars"); // Reaction, Self
    await forcePendingSwap(caster.googleSub, "Lucky Sip"); // Action

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

    // Keeping the newly-drawn Action card discards the Reaction card that
    // made the caster the window's only eligible holder.
    const { data: closedRoundId, error: swapError } = await caster.client.rpc("resolve_card_swap", {
      p_keep_new: true,
      p_room_id: caster.roomId,
    });
    expect(swapError).toBeNull();
    expect(closedRoundId).toBe(roundId);

    expect(await windowStatus(roundId as string)).toBe("closed");
  });

  it("leaves the window open when the resolving player keeps a Reaction card through the swap", async () => {
    const caster = await signUp("swap-keep-reaction-caster");
    const other = await signUp("swap-keep-reaction-other");
    await forceHold(admin, caster.googleSub, "Six Sugars"); // Reaction, Self
    await forcePendingSwap(caster.googleSub, "Lucky Sip"); // Action

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await caster.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });

    // Keeping the old (Reaction) card leaves the caster eligible.
    const { data: closedRoundId, error: swapError } = await caster.client.rpc("resolve_card_swap", {
      p_keep_new: false,
      p_room_id: caster.roomId,
    });
    expect(swapError).toBeNull();
    expect(closedRoundId).toBeNull();

    expect(await windowStatus(roundId as string)).toBe("open");
  });

  it("does not close the window while another eligible holder remains", async () => {
    const caster = await signUp("swap-other-eligible-caster");
    const other = await signUp("swap-other-eligible-other");
    await forceHold(admin, caster.googleSub, "Six Sugars"); // Reaction, Self
    await forcePendingSwap(caster.googleSub, "Lucky Sip"); // Action
    await forceHold(admin, other.googleSub, "Mug Shot"); // Reaction, Opponent

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await caster.client.rpc("open_reaction_window", { p_round_id: roundId, p_layer: 0 });

    const { data: closedRoundId, error: swapError } = await caster.client.rpc("resolve_card_swap", {
      p_keep_new: true,
      p_room_id: caster.roomId,
    });
    expect(swapError).toBeNull();
    expect(closedRoundId).toBeNull();

    expect(await windowStatus(roundId as string)).toBe("open");
  });
});
