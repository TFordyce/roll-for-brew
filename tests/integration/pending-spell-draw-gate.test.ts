import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";
import { getMyPendingSpellDraw } from "@/lib/supabase/spellCards";

// Runs against a real, dedicated test Supabase project. Exercises
// get_my_pending_spell_draw (0066, issue #248) — the Spell Draw Window gate
// on when SpellDrawChoicePanel's "how did you draw?" prompt is offered:
// never before the earning round reaches 'resolved' or 'cancelled'.
describe.skipIf(!hasAnonTestEnv)("getMyPendingSpellDraw: the Spell Draw Window gate", () => {
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

  async function startRoundFor(client: SupabaseClient) {
    const { data: roundId, error } = await client.rpc("start_round");
    if (error) throw error;
    cleanup.trackRound(roundId as string);
    return roundId as string;
  }

  async function setRoundStatus(roundId: string, status: "resolved" | "cancelled", resolvedAt?: Date) {
    const { error } = await admin
      .from("rounds")
      .update({ status, resolved_at: resolvedAt ? resolvedAt.toISOString() : undefined })
      .eq("id", roundId);
    if (error) throw error;
  }

  async function recordTrigger(client: SupabaseClient, roundId: string, trigger: "nat1" | "nat20") {
    const { error } = await client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: trigger });
    if (error) throw error;
  }

  it("returns null when the caller has no pending spell draw at all", async () => {
    const player = await signUp("draw-gate-none");
    const result = await getMyPendingSpellDraw(player.client);
    expect(result).toBeNull();
  });

  it("returns null while the earning round is still open", async () => {
    const player = await signUp("draw-gate-open");
    const roundId = await startRoundFor(player.client);
    await recordTrigger(player.client, roundId, "nat20");

    const result = await getMyPendingSpellDraw(player.client);
    expect(result).toBeNull();
  });

  it("returns null while the earning round is closed (mid-roll/tie-break/reaction-window)", async () => {
    const player = await signUp("draw-gate-closed");
    const other = await signUp("draw-gate-closed-other");
    const roundId = await startRoundFor(player.client);
    await other.client.rpc("declare_in", { p_round_id: roundId });
    await recordTrigger(player.client, roundId, "nat1");

    const { error } = await player.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();

    const result = await getMyPendingSpellDraw(player.client);
    expect(result).toBeNull();
  });

  it("appears once the earning round has resolved", async () => {
    const player = await signUp("draw-gate-resolved");
    const roundId = await startRoundFor(player.client);
    await recordTrigger(player.client, roundId, "nat20");
    await setRoundStatus(roundId, "resolved", new Date());

    const result = await getMyPendingSpellDraw(player.client);
    expect(result).toEqual({ roundId, trigger: "nat20", otherCount: 0 });
  });

  it("appears once the earning round has been cancelled", async () => {
    const player = await signUp("draw-gate-cancelled");
    const roundId = await startRoundFor(player.client);
    await recordTrigger(player.client, roundId, "nat1");
    await setRoundStatus(roundId, "cancelled");

    const result = await getMyPendingSpellDraw(player.client);
    expect(result).toEqual({ roundId, trigger: "nat1", otherCount: 0 });
  });

  it("queues multiple eligible draws oldest-first, with a count of the rest", async () => {
    const player = await signUp("draw-gate-queue");

    const olderRoundId = await startRoundFor(player.client);
    await recordTrigger(player.client, olderRoundId, "nat1");
    await setRoundStatus(olderRoundId, "resolved", new Date(Date.now() - 60 * 60 * 1000));

    const newerRoundId = await startRoundFor(player.client);
    await recordTrigger(player.client, newerRoundId, "nat20");
    await setRoundStatus(newerRoundId, "resolved", new Date());

    const result = await getMyPendingSpellDraw(player.client);
    expect(result).toEqual({ roundId: olderRoundId, trigger: "nat1", otherCount: 1 });

    // Resolving the older one via draw_pending_spell_card clears its row —
    // the newer one is then the only (and therefore oldest) one left.
    const { error } = await player.client.rpc("draw_pending_spell_card", { p_round_id: olderRoundId });
    expect(error).toBeNull();

    const afterResult = await getMyPendingSpellDraw(player.client);
    expect(afterResult).toEqual({ roundId: newerRoundId, trigger: "nat20", otherCount: 0 });
  });

  it("does not count an outstanding draw on a still-open round toward otherCount", async () => {
    const player = await signUp("draw-gate-mixed");

    const resolvedRoundId = await startRoundFor(player.client);
    await recordTrigger(player.client, resolvedRoundId, "nat20");
    await setRoundStatus(resolvedRoundId, "resolved", new Date());

    const openRoundId = await startRoundFor(player.client);
    await recordTrigger(player.client, openRoundId, "nat1");

    const result = await getMyPendingSpellDraw(player.client);
    expect(result).toEqual({ roundId: resolvedRoundId, trigger: "nat20", otherCount: 0 });
  });

  it("never returns another player's pending spell draw", async () => {
    const brewer = await signUp("draw-gate-isolation-a");
    const other = await signUp("draw-gate-isolation-b");

    const roundId = await startRoundFor(brewer.client);
    await recordTrigger(brewer.client, roundId, "nat20");
    await setRoundStatus(roundId, "resolved", new Date());

    const result = await getMyPendingSpellDraw(other.client);
    expect(result).toBeNull();
  });
});
