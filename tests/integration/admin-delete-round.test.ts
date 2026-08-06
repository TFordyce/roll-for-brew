import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises the admin
// round deletion tool (0055, issue #189) — admin_delete_round — through real
// signed-in sessions.
describe.skipIf(!hasAnonTestEnv)("admin_delete_round: hard-deletes an invalid round", () => {
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

  async function startRound(client: SupabaseClient) {
    const { data, error } = await client.rpc("start_round", { p_room_id: null });
    if (error) throw error;
    const roundId = data as string;
    cleanup.trackRound(roundId);
    return roundId;
  }

  it("rejects a non-admin caller (RFB16)", async () => {
    const { client } = await signUpSignInAndEnter("delete-round-not-admin");
    const roundId = await startRound(client);

    const { error } = await client.rpc("admin_delete_round", { p_round_id: roundId, p_reason: "testing" });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB16");

    const { data: stillThere } = await admin.from("rounds").select("id").eq("id", roundId).maybeSingle();
    expect(stillThere).not.toBeNull();
  });

  it("rejects a blank reason (RFB17)", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("delete-round-blank-reason");
    await makeAdmin(googleSub);
    const roundId = await startRound(client);

    const { error } = await client.rpc("admin_delete_round", { p_round_id: roundId, p_reason: "   " });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB17");
  });

  it("rejects a round that doesn't exist (RFB18)", async () => {
    const { client, googleSub } = await signUpSignInAndEnter("delete-round-not-found");
    await makeAdmin(googleSub);

    const { error } = await client.rpc("admin_delete_round", {
      p_round_id: "00000000-0000-0000-0000-000000000000",
      p_reason: "testing",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB18");
  });

  it("deletes the round, cascades its participants, and logs an audit row with the reason", async () => {
    const { client: adminClient, googleSub: adminSub } = await signUpSignInAndEnter("delete-round-admin");
    await makeAdmin(adminSub);
    const { client: starterClient, googleSub: starterSub, roomId } = await signUpSignInAndEnter("delete-round-starter");
    const roundId = await startRound(starterClient);

    const { error } = await adminClient.rpc("admin_delete_round", {
      p_round_id: roundId,
      p_reason: "Marcus was not whitelisted mid-round — resolved by hand outside the app",
    });
    expect(error).toBeNull();

    const { data: roundRow } = await admin.from("rounds").select("id").eq("id", roundId).maybeSingle();
    expect(roundRow).toBeNull();

    const { data: participants } = await admin.from("round_participants").select("round_id").eq("round_id", roundId);
    expect(participants).toEqual([]);

    const { data: auditRows, error: auditError } = await admin
      .from("admin_round_deletions")
      .select("round_id, room_id, round_status, round_started_by, actor_player_id, reason")
      .eq("round_id", roundId);
    if (auditError) throw auditError;
    expect(auditRows).toEqual([
      {
        round_id: roundId,
        room_id: roomId,
        round_status: "open",
        round_started_by: starterSub,
        actor_player_id: adminSub,
        reason: "Marcus was not whitelisted mid-round — resolved by hand outside the app",
      },
    ]);

    // Round is already gone — cleanup's own round teardown for this id is a
    // harmless no-op, but the audit row it left behind isn't tracked by
    // createTestCleanup, so remove it directly here.
    await admin.from("admin_round_deletions").delete().eq("round_id", roundId);
  });
});
