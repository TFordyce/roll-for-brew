import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "../api/client";
import { advanceLayer, finalizeLayer } from "./roundAdvancement";

const roundId = "11111111-1111-4111-8111-111111111111";

const rawOutcome = {
  outcome: "brewer",
  layer: 0,
  brewer_id: "p2",
  cups_made: 1,
  rolls: [{ player_id: "p2", value: 6, discarded_value: null, entered_by_admin: false }],
  replay_pending: false,
};

// The wrappers talk to the API only: any Supabase call at all would be a regression to the
// retired RPCs, so the client is a Proxy that fails the test on first touch.
const supabase = new Proxy({}, {
  get: (_target, prop) => {
    throw new Error(`unexpected supabase.${String(prop)}`);
  },
}) as unknown as SupabaseClient;

const api = (payload: unknown = rawOutcome) =>
  ({
    advanceLayer: vi.fn(async () => payload),
    finalizeLayer: vi.fn(async () => payload),
  }) as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;

describe("round advancement wrappers", () => {
  it.each(["advanceLayer", "finalizeLayer"] as const)("%s calls the API and shapes its payload", async (fn) => {
    const a = api();
    const outcome = fn === "advanceLayer" ? await advanceLayer(supabase, roundId, () => a) : await finalizeLayer(supabase, roundId, () => a);
    expect(a[fn]).toHaveBeenCalledWith(roundId);
    expect(outcome).toMatchObject({ outcome: "brewer", layer: 0, brewerId: "p2", cupsMade: 1 });
  });

  it("carries the version of an API commit", async () => {
    expect((await advanceLayer(supabase, roundId, () => api({ ...rawOutcome, version: 7 }))).version).toBe(7);
    expect((await advanceLayer(supabase, roundId, () => api())).version).toBeUndefined();
  });

  it("shapes a window-opened outcome with its nested finalization and layer rolls", async () => {
    const a = api({
      outcome: "windowOpened",
      layer: 0,
      window_closed: true,
      finalization: rawOutcome,
      layer_rolls: { layer: 0, rolls: rawOutcome.rolls },
    });
    expect(await advanceLayer(supabase, roundId, () => a)).toMatchObject({
      outcome: "windowOpened",
      windowClosed: true,
      finalization: { outcome: "brewer", brewerId: "p2" },
      layerRolls: { layer: 0, rolls: [{ playerId: "p2", value: 6, discardedValue: null, enteredByAdmin: false }] },
    });
  });

  it("shapes a noop", async () => {
    const a = api({ outcome: "noop", reason: "window_open" });
    expect(await finalizeLayer(supabase, roundId, () => a)).toEqual({ outcome: "noop", reason: "window_open" });
  });

  it("lets an API failure through", async () => {
    const a = { advanceLayer: vi.fn(async () => { throw new Error("boom"); }) } as unknown as ApiClient;
    await expect(advanceLayer(supabase, roundId, () => a)).rejects.toThrow("boom");
  });
});
