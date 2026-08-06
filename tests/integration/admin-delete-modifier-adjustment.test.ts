import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the admin
// modifier-adjustment deletion tool (0056, issue #191) --
// admin_delete_modifier_adjustment -- through real signed-in sessions.
describe.skipIf(!hasAnonTestEnv)(
  "admin_delete_modifier_adjustment: deletes any adjustment, reversing its bump",
  () => {
    let admin: SupabaseClient;
    let cleanup: ReturnType<typeof createTestCleanup>;

    beforeAll(() => {
      admin = createTestAdminClient();
      cleanup = createTestCleanup(admin);
    });

    afterEach(() => cleanup.run());

    function signUpSignInAndEnter(label: string) {
      return signUpSignInAndEnterRoom(admin, cleanup, label);
    }

    async function makeAdmin(playerId: string) {
      const { error } = await admin.from("players").update({ is_admin: true }).eq("id", playerId);
      if (error) throw error;
    }

    async function logAdjustment(client: SupabaseClient, targetPlayerId: string, delta: number, reason: string) {
      const { data, error } = await client.rpc("log_modifier_adjustment", {
        p_target_player_id: targetPlayerId,
        p_delta: delta,
        p_reason: reason,
      });
      if (error) throw error;
      return data as string;
    }

    async function getModifier(roomId: string, playerId: string) {
      const { data, error } = await admin
        .from("room_players")
        .select("modifier")
        .eq("room_id", roomId)
        .eq("player_id", playerId)
        .single();
      if (error) throw error;
      return (data as { modifier: number }).modifier;
    }

    it("rejects a non-admin caller (RFB19)", async () => {
      const { client, googleSub } = await signUpSignInAndEnter("del-adj-not-admin");
      const adjustmentId = await logAdjustment(client, googleSub, -4, "testing");

      const { error } = await client.rpc("admin_delete_modifier_adjustment", {
        p_adjustment_id: adjustmentId,
        p_reason: "testing",
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("RFB19");

      const { data: stillThere } = await admin
        .from("modifier_adjustments")
        .select("id")
        .eq("id", adjustmentId)
        .maybeSingle();
      expect(stillThere).not.toBeNull();
    });

    it("rejects a blank reason (RFB20)", async () => {
      const { client, googleSub } = await signUpSignInAndEnter("del-adj-blank-reason");
      await makeAdmin(googleSub);
      const adjustmentId = await logAdjustment(client, googleSub, -4, "testing");

      const { error } = await client.rpc("admin_delete_modifier_adjustment", {
        p_adjustment_id: adjustmentId,
        p_reason: "   ",
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("RFB20");
    });

    it("rejects an adjustment that doesn't exist (RFB21)", async () => {
      const { client, googleSub } = await signUpSignInAndEnter("del-adj-not-found");
      await makeAdmin(googleSub);

      const { error } = await client.rpc("admin_delete_modifier_adjustment", {
        p_adjustment_id: "00000000-0000-0000-0000-000000000000",
        p_reason: "testing",
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe("RFB21");
    });

    it(
      "deletes an adjustment logged by someone else, well outside the 5 minute undo window, " +
        "reverses the bump, and logs an audit row",
      async () => {
        const { client: adminClient, googleSub: adminSub } = await signUpSignInAndEnter("del-adj-admin");
        const { client: actorClient, googleSub: actorSub, roomId } = await signUpSignInAndEnter("del-adj-actor");

        const before = await getModifier(roomId, actorSub);
        const adjustmentId = await logAdjustment(actorClient, actorSub, -4, "Did not lose round");
        const afterLog = await getModifier(roomId, actorSub);
        expect(afterLog).toBe(before - 4);

        // Not the actor, and not within any undo window at all -- the admin
        // path bypasses both of delete_modifier_adjustment's gates (RFB13/14).
        const { error } = await adminClient.rpc("admin_delete_modifier_adjustment", {
          p_adjustment_id: adjustmentId,
          p_reason: "Marcus was not whitelisted mid-round -- this correction was wrong, reverting",
        });
        expect(error).toBeNull();

        const afterDelete = await getModifier(roomId, actorSub);
        expect(afterDelete).toBe(before);

        const { data: row } = await admin
          .from("modifier_adjustments")
          .select("id")
          .eq("id", adjustmentId)
          .maybeSingle();
        expect(row).toBeNull();

        const { data: auditRows, error: auditError } = await admin
          .from("admin_modifier_adjustment_deletions")
          .select("adjustment_id, room_id, target_player_id, original_actor_player_id, delta, original_reason, actor_player_id, reason")
          .eq("adjustment_id", adjustmentId);
        if (auditError) throw auditError;
        expect(auditRows).toEqual([
          {
            adjustment_id: adjustmentId,
            room_id: roomId,
            target_player_id: actorSub,
            original_actor_player_id: actorSub,
            delta: -4,
            original_reason: "Did not lose round",
            actor_player_id: adminSub,
            reason: "Marcus was not whitelisted mid-round -- this correction was wrong, reverting",
          },
        ]);

        // The adjustment row is already gone -- nothing for createTestCleanup
        // to track there -- but the audit row it left behind isn't tracked
        // either, so remove it directly here.
        await admin.from("admin_modifier_adjustment_deletions").delete().eq("adjustment_id", adjustmentId);
      },
    );
  },
);
