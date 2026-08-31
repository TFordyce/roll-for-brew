import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the
// modifier_adjustments table and the log_modifier_adjustment/
// delete_modifier_adjustment RPCs added in
// supabase/migrations/0052_modifier_adjustments.sql (issue #183).
describe.skipIf(!hasAnonTestEnv)("modifier adjustments: log and undo", () => {
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

  async function getModifier(playerId: string, roomId: string): Promise<number> {
    const { data, error } = await admin
      .from("room_players")
      .select("modifier")
      .eq("room_id", roomId)
      .eq("player_id", playerId)
      .single();
    expect(error).toBeNull();
    return data!.modifier as number;
  }

  it("applies the delta to the target's live modifier and logs a row", async () => {
    const [actor, target] = await Promise.all([
      signUp("modadj-log-actor"),
      signUp("modadj-log-target"),
    ]);

    const before = await getModifier(target.googleSub, target.roomId);

    const { data: adjustmentId, error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 3,
      p_reason: "for testing",
    });
    expect(error).toBeNull();
    expect(adjustmentId).toBeTruthy();

    const after = await getModifier(target.googleSub, target.roomId);
    expect(after).toBe(before + 3);

    const { data: row } = await admin
      .from("modifier_adjustments")
      .select("actor_player_id, target_player_id, delta, reason")
      .eq("id", adjustmentId)
      .single();
    expect(row).toEqual({
      actor_player_id: actor.googleSub,
      target_player_id: target.googleSub,
      delta: 3,
      reason: "for testing",
    });
  });

  it("supports negative deltas", async () => {
    const [actor, target] = await Promise.all([
      signUp("modadj-negative-actor"),
      signUp("modadj-negative-target"),
    ]);
    const before = await getModifier(target.googleSub, target.roomId);

    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: -4,
      p_reason: "spilled the tea",
    });
    expect(error).toBeNull();

    const after = await getModifier(target.googleSub, target.roomId);
    expect(after).toBe(before - 4);
  });

  it("rejects a zero delta (RFB10)", async () => {
    const [actor, target] = await Promise.all([
      signUp("modadj-zero-actor"),
      signUp("modadj-zero-target"),
    ]);

    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 0,
      p_reason: "no-op",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB10");
  });

  it("rejects a blank reason (RFB11)", async () => {
    const [actor, target] = await Promise.all([
      signUp("modadj-blank-actor"),
      signUp("modadj-blank-target"),
    ]);

    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 2,
      p_reason: "   ",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB11");
  });

  it("rejects a target not present in the caller's today's room (RFB12)", async () => {
    const actor = await signUp("modadj-outsider-actor");

    const { error } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: "not-a-real-player-id",
      p_delta: 2,
      p_reason: "shouldn't work",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB12");
  });

  it("records the actor as the caller's own identity, never a client value", async () => {
    const [actor, target] = await Promise.all([
      signUp("modadj-actor-identity-actor"),
      signUp("modadj-actor-identity-target"),
    ]);

    const { data: adjustmentId } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 1,
      p_reason: "identity check",
    });

    const { data: row } = await admin
      .from("modifier_adjustments")
      .select("actor_player_id")
      .eq("id", adjustmentId)
      .single();
    expect(row?.actor_player_id).toBe(actor.googleSub);
  });

  it("lets the actor undo their own most-recent adjustment within the window, reversing the modifier", async () => {
    const [actor, target] = await Promise.all([
      signUp("modadj-undo-actor"),
      signUp("modadj-undo-target"),
    ]);
    const before = await getModifier(target.googleSub, target.roomId);

    const { data: adjustmentId } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 5,
      p_reason: "will be undone",
    });

    const { error } = await actor.client.rpc("delete_modifier_adjustment", {
      p_adjustment_id: adjustmentId,
    });
    expect(error).toBeNull();

    const after = await getModifier(target.googleSub, target.roomId);
    expect(after).toBe(before);

    const { data: row } = await admin.from("modifier_adjustments").select("id").eq("id", adjustmentId).maybeSingle();
    expect(row).toBeNull();
  });

  it("rejects undo by a different player than the actor (RFB13)", async () => {
    const [actor, target, bystander] = await Promise.all([
      signUp("modadj-undo-wrong-actor"),
      signUp("modadj-undo-wrong-target"),
      signUp("modadj-undo-wrong-bystander"),
    ]);

    const { data: adjustmentId } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 2,
      p_reason: "actor-only undo",
    });

    const { error } = await bystander.client.rpc("delete_modifier_adjustment", {
      p_adjustment_id: adjustmentId,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB13");
  });

  it("rejects undo of an entry that is not the actor's most-recent (RFB14)", async () => {
    const [actor, target] = await Promise.all([
      signUp("modadj-undo-stale-actor"),
      signUp("modadj-undo-stale-target"),
    ]);

    const { data: firstId } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 1,
      p_reason: "first",
    });
    await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 1,
      p_reason: "second, now the most recent",
    });

    const { error } = await actor.client.rpc("delete_modifier_adjustment", {
      p_adjustment_id: firstId,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB14");
  });

  it("rejects undo once more than 5 minutes have elapsed (RFB15)", async () => {
    const [actor, target] = await Promise.all([
      signUp("modadj-undo-expired-actor"),
      signUp("modadj-undo-expired-target"),
    ]);

    const { data: adjustmentId } = await actor.client.rpc("log_modifier_adjustment", {
      p_target_player_id: target.googleSub,
      p_delta: 1,
      p_reason: "will expire",
    });

    // Back-date created_at past the 5 minute window directly (admin bypasses
    // RLS) rather than sleeping ~5 minutes for real.
    const { error: backdateError } = await admin
      .from("modifier_adjustments")
      .update({ created_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() })
      .eq("id", adjustmentId);
    expect(backdateError).toBeNull();

    const { error } = await actor.client.rpc("delete_modifier_adjustment", {
      p_adjustment_id: adjustmentId,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB15");
  });
});
