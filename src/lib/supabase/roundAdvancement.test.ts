import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "../api/client";
import { advanceLayer, finalizeLayer } from "./roundAdvancement";

type Row = { slice?: string; room_id: string | null; enabled: boolean };

const roundId = "11111111-1111-4111-8111-111111111111";
const roomId = "22222222-2222-4222-8222-222222222222";
const otherRoomId = "33333333-3333-4333-8333-333333333333";

const rawOutcome = {
  outcome: "brewer",
  layer: 0,
  brewer_id: "p2",
  cups_made: 1,
  rolls: [{ player_id: "p2", value: 6, discarded_value: null, entered_by_admin: false }],
  replay_pending: false,
};

function fake(flags: Row[]) {
  const rpc = vi.fn(async () => ({ data: rawOutcome, error: null }));
  const from = vi.fn((table: string) =>
    table === "port_flags"
      ? { select: () => ({ eq: async () => ({ data: flags, error: null }) }) }
      : table === "rounds"
        ? {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { room_id: roomId }, error: null }),
              }),
            }),
          }
        : {},
  );
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc };
}

const api = () =>
  ({
    advanceLayer: vi.fn(async () => rawOutcome),
    finalizeLayer: vi.fn(async () => rawOutcome),
  }) as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;

describe("round advancement wrappers", () => {
  it.each(["advanceLayer", "finalizeLayer"])("%s keeps the RPC when the flag is off", async (fn) => {
    const { supabase, rpc } = fake([]);
    const a = api();
    const outcome = fn === "advanceLayer" ? await advanceLayer(supabase, roundId, () => a) : await finalizeLayer(supabase, roundId, () => a);
    expect(rpc).toHaveBeenCalledWith(fn === "advanceLayer" ? "advance_layer" : "finalize_layer", { p_round_id: roundId });
    expect(fn === "advanceLayer" ? a.advanceLayer : a.finalizeLayer).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ outcome: "brewer", brewerId: "p2" });
  });

  it.each(["advanceLayer", "finalizeLayer"])("%s goes to the API when the global flag is on", async (fn) => {
    const { supabase, rpc } = fake([{ slice: "advanceRound", room_id: null, enabled: true }]);
    const a = api();
    const outcome = fn === "advanceLayer" ? await advanceLayer(supabase, roundId, () => a) : await finalizeLayer(supabase, roundId, () => a);
    expect(fn === "advanceLayer" ? a.advanceLayer : a.finalizeLayer).toHaveBeenCalledWith(roundId);
    expect(rpc).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ outcome: "brewer", layer: 0, brewerId: "p2", cupsMade: 1 });
  });

  it("a room row scopes the flag to that room", async () => {
    const { supabase, rpc } = fake([{ slice: "advanceRound", room_id: otherRoomId, enabled: true }]);
    const a = api();
    await advanceLayer(supabase, roundId, () => a);
    expect(rpc).toHaveBeenCalled();

    const on = fake([{ slice: "advanceRound", room_id: roomId, enabled: true }]);
    const aOn = api();
    await advanceLayer(on.supabase, roundId, () => aOn);
    expect(aOn.advanceLayer).toHaveBeenCalled();
    expect(on.rpc).not.toHaveBeenCalled();
  });

  it("a disabled flag row keeps the RPC", async () => {
    const { supabase, rpc } = fake([{ slice: "advanceRound", room_id: null, enabled: false }]);
    const a = api();
    await advanceLayer(supabase, roundId, () => a);
    expect(rpc).toHaveBeenCalled();
    expect(a.advanceLayer).not.toHaveBeenCalled();
  });
});
