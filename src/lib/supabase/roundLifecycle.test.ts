import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "../api/client";
import { closeRound, declareIn, declareInLate, startRound, withdrawDeclaration } from "./rounds";
import { confirmRoundReplay, declineRoundReplay } from "./roundReplay";
import { cancelRound, excludeRoundParticipant } from "./stall";
import { isStaleRoundError } from "@/app/rounds/roundActionHelpers";

/** A Supabase client that fails the test if a wrapper touches it: every command goes to the API. */
const supabase = new Proxy({}, { get: (_, k) => { throw new Error(`wrapper touched supabase.${String(k)}`); } }) as SupabaseClient;

const ok = { version: 7 as number | null };
const api = () =>
  ({
    startRound: vi.fn(async () => ({ roundId: "api-round", version: 7 })),
    declareIn: vi.fn(async () => ok),
    declareInLate: vi.fn(async () => ok),
    withdrawDeclaration: vi.fn(async () => ok),
    closeRound: vi.fn(async () => ok),
    cancelRound: vi.fn(async () => ok),
    excludeRoundParticipant: vi.fn(async () => ok),
    confirmRoundReplay: vi.fn(async () => ok),
    declineRoundReplay: vi.fn(async () => ok),
  }) as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;

const cases: [string, unknown[], (a: () => ApiClient) => Promise<unknown>][] = [
  ["declareIn", ["r1"], (a) => declareIn(supabase, "r1", a)],
  ["declareInLate", ["r1"], (a) => declareInLate(supabase, "r1", a)],
  ["withdrawDeclaration", ["r1"], (a) => withdrawDeclaration(supabase, "r1", a)],
  ["closeRound", ["r1"], (a) => closeRound(supabase, "r1", a)],
  ["cancelRound", ["r1"], (a) => cancelRound(supabase, "r1", a)],
  ["excludeRoundParticipant", ["r1", "p1", 0], (a) => excludeRoundParticipant(supabase, "r1", "p1", 0, a)],
  ["confirmRoundReplay", ["r1"], (a) => confirmRoundReplay(supabase, "r1", a)],
  ["declineRoundReplay", ["r1"], (a) => declineRoundReplay(supabase, "r1", a)],
];

describe.each(cases)("%s", (method, apiArgs, call) => {
  it("goes to the API", async () => {
    const a = api();
    await call(() => a);
    expect(a[method]).toHaveBeenCalledWith(...apiArgs);
  });
});

describe("startRound", () => {
  it("returns the API's round id for the room being started", async () => {
    const a = api();
    expect(await startRound(supabase, "room-a", () => a)).toBe("api-round");
    expect(a.startRound).toHaveBeenCalledWith("room-a");
  });
});

describe("isStaleRoundError", () => {
  it.each(["round_not_open_for_declarations", "round_closed_for_late_declare"])("treats %s as a lost race", (code) =>
    expect(isStaleRoundError({ code })).toBe(true),
  );
  it("does not swallow a refusal that is the caller's problem", () => expect(isStaleRoundError({ code: "close_not_starter" })).toBe(false));
});
