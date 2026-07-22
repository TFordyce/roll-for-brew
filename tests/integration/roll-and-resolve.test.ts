import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { broadcastRoundRevealed } from "../../src/lib/supabase/realtime";
import {
  createTestAdminClient,
  createTestAnonClient,
  createTestCleanup,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// submit_roll / get_layer0_rolls_if_complete / resolve_round RPCs
// (supabase/migrations/0005_rolls_and_resolution.sql) through real signed-in
// sessions, the same way the app drives them via
// src/app/rounds/actions.ts:submitRollAction — start -> declare -> roll ->
// resolve -> modifier-increment, for a round that doesn't tie or hit a nat.
describe.skipIf(!hasAnonTestEnv)("roll & resolve (happy path)", () => {
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

  type LayerZeroRow = { player_id: string; value: number; modifier_snapshot: number };

  /**
   * Deterministically decides who *should* win a two-player layer-0 (lowest
   * roll+modifier), and flags whether a nat-1 or an exact tie landed by
   * chance — in which case the caller skips resolving, since tie-break and
   * nat-1/nat-20 UI wiring are out of scope for #19 (the engine's own
   * precedence there is covered by resolveLayer's unit tests, not
   * re-asserted here).
   */
  function pickTwoPlayerBrewer(rows: LayerZeroRow[]): { brewerId: string; isSpecialCase: boolean } {
    const [a, b] = rows as [LayerZeroRow, LayerZeroRow];
    const aTotal = a.value + a.modifier_snapshot;
    const bTotal = b.value + b.modifier_snapshot;
    const isSpecialCase = a.value === 1 || b.value === 1 || aTotal === bTotal;
    return { brewerId: aTotal <= bTotal ? a.player_id : b.player_id, isSpecialCase };
  }

  it("submits layer-0 rolls, hides them until personally submitted, then resolves the brewer and increments their modifier", async () => {
    const starter = await signUp("roll-starter");
    const other = await signUp("roll-other");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    const { error: closeError } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(closeError).toBeNull();

    // Before the starter has rolled, they can't see the other player's roll
    // (RLS: only your own row, or everyone's once resolved).
    const { error: starterRollErr } = await starter.client.rpc("submit_roll", {
      p_round_id: roundId,
    });
    expect(starterRollErr).toBeNull();

    const { data: peekBeforeOwnRoll, error: peekError } = await other.client
      .from("rolls")
      .select("player_id, value")
      .eq("round_id", roundId)
      .eq("player_id", starter.googleSub);
    expect(peekError).toBeNull();
    expect(peekBeforeOwnRoll).toEqual([]);

    // The starter can read their own roll immediately.
    const { data: ownRoll, error: ownRollError } = await starter.client
      .from("rolls")
      .select("value")
      .eq("round_id", roundId)
      .eq("player_id", starter.googleSub)
      .single();
    expect(ownRollError).toBeNull();
    expect(ownRoll!.value).toBeGreaterThanOrEqual(1);
    expect(ownRoll!.value).toBeLessThanOrEqual(20);

    // Round isn't complete yet — resolution read returns nothing.
    const { data: incomplete } = await starter.client.rpc("get_layer0_rolls_if_complete", {
      p_round_id: roundId,
    });
    expect(incomplete).toEqual([]);

    const { error: otherRollErr } = await other.client.rpc("submit_roll", {
      p_round_id: roundId,
    });
    expect(otherRollErr).toBeNull();

    // Now that everyone has rolled, the complete layer is readable — but
    // only to a participant of this round (get_layer0_rolls_if_complete
    // guards against a side door around the "hidden until revealed" rule).
    const { error: nonParticipantReadError } = await (
      await signUp("roll-nonparticipant")
    ).client.rpc("get_layer0_rolls_if_complete", { p_round_id: roundId });
    expect(nonParticipantReadError).not.toBeNull();

    const { data: complete, error: completeError } = await starter.client.rpc(
      "get_layer0_rolls_if_complete",
      { p_round_id: roundId },
    );
    expect(completeError).toBeNull();
    expect(complete).toHaveLength(2);

    const rows = complete as LayerZeroRow[];
    const { brewerId, isSpecialCase } = pickTwoPlayerBrewer(rows);
    if (isSpecialCase) return;

    const { error: resolveError } = await starter.client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: brewerId,
      p_cups_made: rows.length,
    });
    expect(resolveError).toBeNull();

    const { data: round, error: roundError } = await admin
      .from("rounds")
      .select("status, brewer_id, cups_made, resolved_at")
      .eq("id", roundId)
      .single();
    expect(roundError).toBeNull();
    expect(round).toMatchObject({ status: "resolved", brewer_id: brewerId, cups_made: 2 });
    expect(round!.resolved_at).not.toBeNull();

    const { data: roomPlayer, error: roomPlayerError } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", starter.roomId)
      .eq("player_id", brewerId)
      .single();
    expect(roomPlayerError).toBeNull();
    expect(roomPlayer!.modifier).toBe(2);

    // Once resolved, everyone (not just the roller) can read every roll.
    const { data: revealedToOther, error: revealedError } = await other.client
      .from("rolls")
      .select("player_id, value")
      .eq("round_id", roundId);
    expect(revealedError).toBeNull();
    expect(revealedToOther).toHaveLength(2);
  });

  it("resolve_round rejects a brewer who isn't a participant in the round", async () => {
    const starter = await signUp("resolve-guard-starter");
    const other = await signUp("resolve-guard-other");
    const outsider = await signUp("resolve-guard-outsider");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await starter.client.rpc("close_round", { p_round_id: roundId });

    await starter.client.rpc("submit_roll", { p_round_id: roundId });
    await other.client.rpc("submit_roll", { p_round_id: roundId });

    const { error } = await starter.client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: outsider.googleSub,
      p_cups_made: 2,
    });
    expect(error).not.toBeNull();

    const { data: round } = await admin.from("rounds").select("status").eq("id", roundId).single();
    expect(round?.status).toBe("closed");
  });

  it("submit_roll rejects a caller who is not a declared participant", async () => {
    const starter = await signUp("roll-guard-starter");
    const other = await signUp("roll-guard-other");
    const bystander = await signUp("roll-guard-bystander");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await starter.client.rpc("close_round", { p_round_id: roundId });

    const { error } = await bystander.client.rpc("submit_roll", { p_round_id: roundId });
    expect(error).not.toBeNull();
  });

  it("submit_roll rejects rolling before the round is closed", async () => {
    const starter = await signUp("roll-open-starter");
    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const { error } = await starter.client.rpc("submit_roll", { p_round_id: roundId });
    expect(error).not.toBeNull();
  });

  it("broadcasts a round-revealed event on the room's Realtime channel when resolved", async () => {
    const starter = await signUp("broadcast-starter");
    const other = await signUp("broadcast-other");

    const { data: roundId } = await starter.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await starter.client.rpc("close_round", { p_round_id: roundId });

    const listener = createTestAnonClient();
    const channel: RealtimeChannel = listener.channel(`room:${starter.roomId}`);

    const received = new Promise<Record<string, unknown>>((resolve) => {
      channel.on("broadcast", { event: "round-revealed" }, ({ payload }) => resolve(payload));
    });

    await new Promise<void>((resolve) => {
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve();
      });
    });

    await starter.client.rpc("submit_roll", { p_round_id: roundId });
    await other.client.rpc("submit_roll", { p_round_id: roundId });

    const { data: rows } = await starter.client.rpc("get_layer0_rolls_if_complete", {
      p_round_id: roundId,
    });
    const complete = rows as LayerZeroRow[];
    const { brewerId, isSpecialCase } = pickTwoPlayerBrewer(complete);
    if (isSpecialCase) {
      await channel.unsubscribe();
      return;
    }

    await starter.client.rpc("resolve_round", {
      p_round_id: roundId,
      p_brewer_id: brewerId,
      p_cups_made: 2,
    });

    await broadcastRoundRevealed(starter.client, starter.roomId, {
      roundId: roundId as string,
      brewerId,
      cupsMade: 2,
      rolls: complete.map((r) => ({ playerId: r.player_id, value: r.value })),
    });

    const payload = await received;
    expect(payload).toMatchObject({ roundId, brewerId, cupsMade: 2 });

    await channel.unsubscribe();
  });
});
