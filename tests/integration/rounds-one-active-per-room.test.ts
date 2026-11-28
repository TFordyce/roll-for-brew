import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasTestEnv, uniqueTestEmail } from "./setup";

// Schema-level checks that don't depend on "today" or real auth sessions,
// using explicit seeded data via the admin (service-role) client directly —
// mirrors the "enforces one room per date" pattern in
// tests/integration/room-auto-creation.test.ts.
describe.skipIf(!hasTestEnv)("rounds_one_active_per_room constraint", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  it("allows only one open-or-closed round per room at a time", async () => {
    const email = uniqueTestEmail("constraint-player");
    const googleSub = `google-sub-constraint-${Date.now()}`;
    cleanup.trackPlayerId(googleSub);
    await admin.from("players").insert({ id: googleSub, email, display_name: "Constraint Player" });

    const { data: room } = await admin
      .from("rooms")
      .insert({ date: "2020-03-03" })
      .select("id")
      .single();
    cleanup.trackRoom(room!.id);

    const { data: firstRound, error: firstError } = await admin
      .from("rounds")
      .insert({ room_id: room!.id, started_by: googleSub, status: "open" })
      .select("id")
      .single();
    expect(firstError).toBeNull();
    cleanup.trackRound(firstRound!.id);

    const { error: secondError } = await admin
      .from("rounds")
      .insert({ room_id: room!.id, started_by: googleSub, status: "open" });
    expect(secondError).not.toBeNull();

    // A resolved/cancelled round doesn't count as active, so a new one can
    // start once the prior one is out of the way.
    await admin.from("rounds").update({ status: "resolved" }).eq("id", firstRound!.id);

    const { data: thirdRound, error: thirdError } = await admin
      .from("rounds")
      .insert({ room_id: room!.id, started_by: googleSub, status: "open" })
      .select("id")
      .single();
    expect(thirdError).toBeNull();
    cleanup.trackRound(thirdRound!.id);
  });
});
