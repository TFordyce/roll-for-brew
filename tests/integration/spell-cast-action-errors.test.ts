import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, forceHold, hasAnonTestEnv, signUpSignInAndEnterRoom } from "./setup";

// Issue #244: the server actions wrapping the spell-cast RPCs only caught
// the "stale round" RFB0x error family — every other precondition failure
// re-threw past the action boundary, bubbling to the root error boundary
// instead of the specific inline error the panel/form should render. This
// suite exercises the fix at the action layer (not just the RPC directly,
// as spell-cards.test.ts does), which is what the issue's own acceptance
// criteria call for.
//
// Runs against a real, dedicated test Supabase project, same as the rest of
// tests/integration/. `@/lib/supabase/server`'s createClient() reads
// next/headers cookies(), which only works inside an actual Next.js request
// — outside that (as here) it throws, so it's swapped for the already
// signed-in test client via vi.mock instead of trying to fake a request.
let mockClient: SupabaseClient;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockClient,
}));

const { castSpellCardAction } = await import("@/app/rounds/actions");

describe.skipIf(!hasAnonTestEnv)("spell-cast server actions: typed error handling (issue #244)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  it("castSpellCardAction returns a typed error, rather than throwing, for a non-stale-round precondition failure", async () => {
    const { client, googleSub } = await signUpSignInAndEnterRoom(admin, cleanup, "cast-action-error");
    await forceHold(admin, googleSub, "Calami-Tea"); // Action, CHOSEN_PLAYERS — requires at least one chosen player
    mockClient = client;

    const { data: roundId } = await client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    const formData = new FormData();
    formData.set("roundId", roundId as string);
    // Deliberately no chosenPlayerIds entries — cast_spell_card rejects with
    // "this card requires at least one chosen player", which has nothing to
    // do with a stale round.

    const result = await castSpellCardAction({ status: "idle" }, formData);

    expect(result).toEqual({
      status: "error",
      message: "this card requires at least one chosen player",
    });

    // Confirms this really is the typed-result path, not a caught throw
    // that happened to look similar: the card should still be held, since
    // the RPC rejected before it ever cleared spell_deck_instances.
    const { data: instance } = await admin
      .from("spell_deck_instances")
      .select("location, held_by_player")
      .eq("held_by_player", googleSub)
      .single();
    expect(instance).toEqual({ location: "held", held_by_player: googleSub });
  });
});
