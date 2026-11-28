import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "../api/client";
import { adminProxyRoll, submitManualRoll, submitManualRollAs, submitRoll, submitRollAs } from "./rolls";
import { isStaleRoundError } from "@/app/rounds/roundActionHelpers";

/** A Supabase client that fails the test if a wrapper touches it: every roll goes to the API. */
const supabase = new Proxy({}, { get: (_, k) => { throw new Error(`wrapper touched supabase.${String(k)}`); } }) as SupabaseClient;

const api = () =>
  ({
    submitRoll: vi.fn(async () => ({ value: 17, version: 7 })),
    submitManualRoll: vi.fn(async () => ({ value: 9, version: 7 })),
    submitRollAs: vi.fn(async () => ({ value: 17, version: 7 })),
    submitManualRollAs: vi.fn(async () => ({ value: 9, version: 7 })),
    adminProxyRoll: vi.fn(async () => ({ value: 9, version: 7 })),
  }) as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;

const cases: [string, unknown[], (a: () => ApiClient) => Promise<unknown>][] = [
  ["submitRoll", ["r1"], (a) => submitRoll(supabase, "r1", a)],
  ["submitManualRoll", ["r1", 9], (a) => submitManualRoll(supabase, "r1", 9, a)],
  ["submitRollAs", ["r1", "p1"], (a) => submitRollAs(supabase, "r1", "p1", a)],
  ["submitManualRollAs", ["r1", "p1", 9], (a) => submitManualRollAs(supabase, "r1", "p1", 9, a)],
  ["adminProxyRoll", ["r1", "p1", 9], (a) => adminProxyRoll(supabase, "r1", "p1", 9, a)],
];

describe.each(cases)("%s", (method, apiArgs, call) => {
  it("goes to the API", async () => {
    const a = api();
    await call(() => a);
    expect(a[method]).toHaveBeenCalledWith(...apiArgs);
  });
});

it("an auto roll returns the API's rolled value", async () => {
  expect(await submitRoll(supabase, "r1", () => api())).toBe(17);
  expect(await submitRollAs(supabase, "r1", "p1", () => api())).toBe(17);
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
