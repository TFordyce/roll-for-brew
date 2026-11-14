import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "../api/client";
import { closeRound, declareIn, declareInLate, startRound, withdrawDeclaration } from "./rounds";
import { confirmRoundReplay, declineRoundReplay } from "./roundReplay";
import { cancelRound, excludeRoundParticipant } from "./stall";
import { isStaleRoundError } from "@/app/rounds/roundActionHelpers";

type Row = { room_id: string | null; enabled: boolean };

/** Flag rows for any slice, and a round that sits in `roundRoom`. */
function fake(flags: Row[], roundRoom = "room-a") {
  const rpc = vi.fn(async () => ({ data: "round-1", error: null }));
  const from = vi.fn((table: string) =>
    table === "port_flags"
      ? { select: () => ({ eq: async () => ({ data: flags, error: null }) }) }
      : { select: () => ({ eq: () => ({ single: async () => ({ data: { room_id: roundRoom }, error: null }) }) }) },
  );
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc, from };
}

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

const on: Row[] = [{ room_id: null, enabled: true }];

const cases: [string, string, Record<string, unknown>, (s: SupabaseClient, a: () => ApiClient) => Promise<unknown>][] = [
  ["declareIn", "declare_in", { p_round_id: "r1" }, (s, a) => declareIn(s, "r1", a)],
  ["declareInLate", "declare_in_late", { p_round_id: "r1" }, (s, a) => declareInLate(s, "r1", a)],
  ["withdrawDeclaration", "withdraw_declaration", { p_round_id: "r1" }, (s, a) => withdrawDeclaration(s, "r1", a)],
  ["closeRound", "close_round", { p_round_id: "r1" }, (s, a) => closeRound(s, "r1", a)],
  ["cancelRound", "cancel_round", { p_round_id: "r1" }, (s, a) => cancelRound(s, "r1", a)],
  [
    "excludeRoundParticipant",
    "exclude_round_participant",
    { p_round_id: "r1", p_player_id: "p1", p_layer: 0 },
    (s, a) => excludeRoundParticipant(s, "r1", "p1", 0, a),
  ],
  ["confirmRoundReplay", "confirm_round_replay", { p_round_id: "r1" }, (s, a) => confirmRoundReplay(s, "r1", a)],
  ["declineRoundReplay", "decline_round_replay", { p_round_id: "r1" }, (s, a) => declineRoundReplay(s, "r1", a)],
];

describe.each(cases)("%s", (method, rpcName, rpcArgs, call) => {
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
    expect(a[method]).toHaveBeenCalledTimes(1);
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

  it("does not look the round's room up while no room row exists", async () => {
    const { supabase, from } = fake(on);
    await call(supabase, () => api());
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("port_flags");
  });
});

describe("startRound", () => {
  it("keeps the RPC when the flag is off", async () => {
    const { supabase, rpc } = fake([]);
    const a = api();
    expect(await startRound(supabase, "room-a", () => a)).toBe("round-1");
    expect(rpc).toHaveBeenCalledWith("start_round", { p_room_id: "room-a" });
    expect(a.startRound).not.toHaveBeenCalled();
  });

  it("returns the API's round id when the flag is on", async () => {
    const { supabase, rpc } = fake(on);
    const a = api();
    expect(await startRound(supabase, undefined, () => a)).toBe("api-round");
    expect(a.startRound).toHaveBeenCalledWith(undefined);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("scopes a room row to the room being started", async () => {
    const test = [{ room_id: "room-test", enabled: true }];
    const a = api();
    await startRound(fake(test).supabase, "room-test", () => a);
    expect(a.startRound).toHaveBeenCalledWith("room-test");

    const b = api();
    const other = fake(test);
    await startRound(other.supabase, "room-a", () => b);
    expect(b.startRound).not.toHaveBeenCalled();
    expect(other.rpc).toHaveBeenCalled();
  });
});

describe("isStaleRoundError", () => {
  it.each(["RFB05", "RFB31", "round_not_open_for_declarations", "round_closed_for_late_declare"])("treats %s as a lost race", (code) =>
    expect(isStaleRoundError({ code })).toBe(true),
  );
  it("does not swallow a refusal that is the caller's problem", () => expect(isStaleRoundError({ code: "close_not_starter" })).toBe(false));
});
