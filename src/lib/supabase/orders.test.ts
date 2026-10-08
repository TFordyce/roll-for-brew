import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMyMostRecentOrder, getMyOrderForRound, submitOrder } from "./orders";

type Row = { slice?: string; room_id: string | null; enabled: boolean };

// port_flags select(...).eq("slice", s) -> rows; orders chain resolves a direct read.
function fake(flags: Row[]) {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const ordersRead = { data: { drink_type: "tea" }, error: null };
  const chain: Record<string, unknown> = {};
  for (const k of ["eq", "order", "limit"]) chain[k] = () => chain;
  chain.maybeSingle = async () => ordersRead;
  const from = vi.fn((table: string) =>
    table === "port_flags"
      ? { select: () => ({ eq: async () => ({ data: flags, error: null }) }) }
      : { select: () => chain },
  );
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc };
}

const api = () => ({
  getActingAs: vi.fn(),
  submitOrder: vi.fn(async () => {}),
  getMyOrderForRound: vi.fn(async () => ({ drinkType: "coffee" as string | null })),
  getMyMostRecentOrder: vi.fn(async () => ({ drinkType: null as string | null })),
});

describe("order wrappers", () => {
  it("submitOrder keeps the RPC when the flag is off", async () => {
    const { supabase, rpc } = fake([]);
    const a = api();
    await submitOrder(supabase, "r1", "tea", () => a);
    expect(rpc).toHaveBeenCalledWith("submit_order", { p_round_id: "r1", p_drink_type: "tea" });
    expect(a.submitOrder).not.toHaveBeenCalled();
  });

  it("submitOrder goes to the API when the flag is on", async () => {
    const { supabase, rpc } = fake([{ room_id: null, enabled: true }]);
    const a = api();
    await submitOrder(supabase, "r1", "coffee", () => a);
    expect(a.submitOrder).toHaveBeenCalledWith("r1", "coffee");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads use PostgREST when off and the API when on", async () => {
    const off = fake([]);
    expect(await getMyOrderForRound(off.supabase, "r1", "p1", api)).toBe("tea");
    expect(await getMyMostRecentOrder(off.supabase, "p1", api)).toBe("tea");

    const on = fake([{ room_id: null, enabled: true }]);
    const a = api();
    expect(await getMyOrderForRound(on.supabase, "r1", "p1", () => a)).toBe("coffee");
    expect(a.getMyOrderForRound).toHaveBeenCalledWith("r1");
    expect(await getMyMostRecentOrder(on.supabase, "p1", () => a)).toBeNull();
  });
});
