import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "../api/client";
import { adminProxyRoll, submitManualRoll, submitManualRollAs, submitRoll, submitRollAs } from "./rolls";
import { isStaleRoundError } from "@/app/rounds/roundActionHelpers";

type Row = { room_id: string | null; enabled: boolean };

/** Flag rows for any slice, and a round that sits in `roundRoom`. */
function fake(flags: Row[], roundRoom = "room-a") {
  const rpc = vi.fn(async () => ({ data: 11, error: null }));
  const from = vi.fn((table: string) =>
    table === "port_flags"
      ? { select: () => ({ eq: async () => ({ data: flags, error: null }) }) }
      : { select: () => ({ eq: () => ({ single: async () => ({ data: { room_id: roundRoom }, error: null }) }) }) },
  );
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc, from };
}

const api = () =>
  ({
    submitRoll: vi.fn(async () => ({ value: 17, version: 7 })),
    submitManualRoll: vi.fn(async () => ({ value: 9, version: 7 })),
    submitRollAs: vi.fn(async () => ({ value: 17, version: 7 })),
    submitManualRollAs: vi.fn(async () => ({ value: 9, version: 7 })),
    adminProxyRoll: vi.fn(async () => ({ value: 9, version: 7 })),
  }) as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;

const on: Row[] = [{ room_id: null, enabled: true }];

const cases: [string, string, Record<string, unknown>, unknown[], (s: SupabaseClient, a: () => ApiClient) => Promise<unknown>][] = [
  ["submitRoll", "submit_roll", { p_round_id: "r1" }, ["r1"], (s, a) => submitRoll(s, "r1", a)],
  [
    "submitManualRoll",
    "submit_manual_roll",
    { p_round_id: "r1", p_value: 9 },
    ["r1", 9],
    (s, a) => submitManualRoll(s, "r1", 9, a),
  ],
  [
    "submitRollAs",
    "submit_roll_as",
    { p_round_id: "r1", p_player_id: "p1" },
    ["r1", "p1"],
    (s, a) => submitRollAs(s, "r1", "p1", a),
  ],
  [
    "submitManualRollAs",
    "submit_manual_roll_as",
    { p_round_id: "r1", p_player_id: "p1", p_value: 9 },
    ["r1", "p1", 9],
    (s, a) => submitManualRollAs(s, "r1", "p1", 9, a),
  ],
  [
    "adminProxyRoll",
    "admin_proxy_roll",
    { p_round_id: "r1", p_player_id: "p1", p_value: 9 },
    ["r1", "p1", 9],
    (s, a) => adminProxyRoll(s, "r1", "p1", 9, a),
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
    const a = api();
    await call(supabase, () => a);
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

describe("the rolled value", () => {
  it("comes back from the API for an auto roll", async () => {
    expect(await submitRoll(fake(on).supabase, "r1", () => api())).toBe(17);
    expect(await submitRollAs(fake(on).supabase, "r1", "p1", () => api())).toBe(17);
  });

  it("comes back from the RPC for an auto roll", async () => {
    expect(await submitRoll(fake([]).supabase, "r1", () => api())).toBe(11);
  });
});

describe("a stale roll", () => {
  it.each(["RFB01", "RFB02", "RFB32", "round_not_open_for_rolling", "not_expected_roller", "round_closed_for_proxy_roll"])(
    "treats %s as a lost race",
    (code) => expect(isStaleRoundError({ code })).toBe(true),
  );
  it("does not swallow a refusal that is the caller's problem", () => {
    expect(isStaleRoundError({ code: "admin_required" })).toBe(false);
    expect(isStaleRoundError({ code: "roll_value_out_of_range" })).toBe(false);
  });
});
