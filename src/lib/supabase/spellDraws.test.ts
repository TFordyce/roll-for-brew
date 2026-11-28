import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "../api/client";
import { drawPendingSpellCard, drawPendingSpellCardManual, drawSpellCardAs, recordPendingSpellDraw } from "./spellCards";

type Row = { room_id: string | null; enabled: boolean };

/** Flag rows for any slice, a round that sits in `roundRoom`, and an RPC that drew instance i-sql. */
function fake(flags: Row[], roundRoom = "room-a") {
  const rpc = vi.fn(async () => ({ data: [{ instance_id: "i-sql", needs_swap_decision: false }], error: null }));
  const from = vi.fn((table: string) =>
    table === "port_flags"
      ? { select: () => ({ eq: async () => ({ data: flags, error: null }) }) }
      : { select: () => ({ eq: () => ({ single: async () => ({ data: { room_id: roundRoom }, error: null }) }) }) },
  );
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc };
}

const drew = { instanceId: "i-api", needsSwapDecision: true, version: 7 };

const api = () =>
  ({
    recordPendingSpellDraw: vi.fn(async () => ({ version: 7 })),
    drawPendingSpellCard: vi.fn(async () => drew),
    drawPendingSpellCardManual: vi.fn(async () => drew),
    drawSpellCardAs: vi.fn(async () => drew),
  }) as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;

const on: Row[] = [{ room_id: null, enabled: true }];

const cases: [string, string, Record<string, unknown>, unknown[], (s: SupabaseClient, a: () => ApiClient) => Promise<unknown>][] = [
  [
    "recordPendingSpellDraw",
    "record_pending_spell_draw",
    { p_round_id: "r1", p_trigger: "nat20" },
    ["r1", "nat20"],
    (s, a) => recordPendingSpellDraw(s, "r1", "nat20", a),
  ],
  ["drawPendingSpellCard", "draw_pending_spell_card", { p_round_id: "r1" }, ["r1"], (s, a) => drawPendingSpellCard(s, "r1", a)],
  [
    "drawPendingSpellCardManual",
    "draw_pending_spell_card_manual",
    { p_round_id: "r1", p_card_id: "c1" },
    ["r1", "c1"],
    (s, a) => drawPendingSpellCardManual(s, "r1", "c1", a),
  ],
  [
    "drawSpellCardAs",
    "draw_spell_card_as",
    { p_trigger: "nat1", p_room_id: "room-a", p_round_id: "r1", p_player_id: "p1", p_card_id: "c1" },
    ["r1", "nat1", "p1", "c1"],
    (s, a) => drawSpellCardAs(s, "nat1", "room-a", "r1", "p1", "c1", a),
  ],
];

describe.each(cases)("%s", (method, rpcName, rpcArgs, apiArgs, call) => {
  it("keeps the RPC when the flag is off", async () => {
    const { supabase, rpc } = fake([]);
    const a = api();
    await call(supabase, () => a);
    expect(rpc).toHaveBeenCalledWith(rpcName, rpcArgs);
    expect(a[method]).not.toHaveBeenCalled();
  });

  it("goes to the API when the global flag is on", async () => {
    const { supabase, rpc } = fake(on);
    const a = api();
    await call(supabase, () => a);
    expect(a[method]).toHaveBeenCalledWith(...apiArgs);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rolls back to the RPC when the flag is disabled", async () => {
    const { supabase, rpc } = fake([{ room_id: null, enabled: false }]);
    await call(supabase, () => api());
    expect(rpc).toHaveBeenCalledWith(rpcName, rpcArgs);
  });

  it("lets a Test Room row switch only its own room", async () => {
    const test = [{ room_id: "room-test", enabled: true }];
    const inTest = fake(test, "room-test");
    const a1 = api();
    await call(inTest.supabase, () => a1);
    expect(a1[method]).toHaveBeenCalledTimes(1);

    const elsewhere = fake(test, "room-a");
    const a2 = api();
    await call(elsewhere.supabase, () => a2);
    expect(a2[method]).not.toHaveBeenCalled();
    expect(elsewhere.rpc).toHaveBeenCalledWith(rpcName, rpcArgs);
  });
});

describe("the drawn card", () => {
  it("comes back from the API in the RPC's shape", async () => {
    expect(await drawPendingSpellCard(fake(on).supabase, "r1", () => api())).toEqual({
      instanceId: "i-api",
      needsSwapDecision: true,
    });
  });

  it("is null when the API drew nothing", async () => {
    const a = api();
    (a.drawPendingSpellCard as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ instanceId: null, needsSwapDecision: false, version: 8 });
    expect(await drawPendingSpellCard(fake(on).supabase, "r1", () => a)).toBeNull();
  });
});
