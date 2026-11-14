import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError, createApiClient, type ApiClient } from "@/lib/api/client";
import { getRoundRecap } from "./roundRecap";
import { adminBackfillRound, backfillFailureMessage } from "./adminBackfill";

// Both wrappers talk to the API only: any Supabase call would be a regression to the retired RPCs.
const supabase = new Proxy({}, {
  get: (_target, prop) => {
    throw new Error(`unexpected supabase.${String(prop)}`);
  },
}) as unknown as SupabaseClient;

const rawRecap = {
  resolved: false,
  layer_zero_outcome: null,
  trace: [],
  players: [{ player_id: "p", roll: 3, snapshot: 1, composed: 1, total: 4, nat: null, dice_reduced: false }],
  provisional: true,
  casts: [],
  scrapped_generations: [],
  layers: [{ player_id: "p", layer: 0, value: 3, modifier_snapshot: 1, discarded_value: null, entered_by_admin: false }],
  layer_participants: [],
  reaction_skips: [{ player_id: "q", reason: "vote" }],
};

describe("getRoundRecap", () => {
  it("parses the API's payload", async () => {
    const recap = await getRoundRecap(supabase, "round", () => ({ getRoundRecap: async () => rawRecap }) as unknown as ApiClient);
    expect(recap).toMatchObject({
      provisional: true,
      summary: [{ playerId: "p", roll: 3, snapshot: 1, composed: 1, total: 4, nat: null, diceReduced: false }],
      reactionSkips: [{ playerId: "q", reason: "vote" }],
    });
  });

  it.each(["recap_not_in_room", "round_not_found"])("reads %s as no recap, without logging, as the rpc's raise did", async (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = () => ({ getRoundRecap: async () => { throw new ApiError("/x", 403, code); } }) as unknown as ApiClient;
    expect(await getRoundRecap(supabase, "round", api)).toBeNull();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs any other API failure and still shows no recap", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = () => ({ getRoundRecap: async () => { throw new ApiError("/x", 500, "internal_error"); } }) as unknown as ApiClient;
    expect(await getRoundRecap(supabase, "round", api)).toBeNull();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe("adminBackfillRound", () => {
  const layers = [[{ playerId: "a", value: 5 }, { playerId: "b", value: 12 }]];

  it("posts to the API", async () => {
    const adminBackfill = vi.fn(async () => ({ roundId: "round-2" }));
    const id = await adminBackfillRound(supabase, ["a", "b"], layers, () => ({ adminBackfillRound: adminBackfill }) as unknown as ApiClient);
    expect(id).toBe("round-2");
    expect(adminBackfill).toHaveBeenCalledWith(["a", "b"], layers);
  });
});

describe("backfillFailureMessage", () => {
  it("reads the sentence from the API's problem", () => {
    const message = "admin_backfill_round: layer 0 is still tied — a further layer is required";
    const expected = "Layer 0 is still tied — a further layer is required.";
    expect(backfillFailureMessage(new ApiError("/rounds/backfill", 400, "backfill_layer_still_tied", message))).toBe(expected);
  });

  it("falls back when a known refusal has no words", () => {
    expect(backfillFailureMessage(new ApiError("/rounds/backfill", 400, "backfill_no_layers", ""))).toBe("Could not backfill that round.");
  });

  it.each([
    [{ code: "P0001", message: "resolve_round: brewer is not a participant in this round" }],
    [new ApiError("/rounds/backfill", 422, "backfill_not_resolvable", "resolve_round: brewer is not a participant in this round")],
    [new Error("network")],
    [null],
  ])("leaves anything else to throw", (error) => {
    expect(backfillFailureMessage(error)).toBeNull();
  });
});

describe("createApiClient problems", () => {
  it("throws an ApiError carrying the problem's code and detail", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: "backfill_no_layers", detail: "words", title: "t" }), { status: 400 }));
    const c = createApiClient("https://api.test", async () => "jwt", f as unknown as typeof fetch);
    const error = await c.adminBackfillRound(["a"], []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "backfill_no_layers", detail: "words" });
    expect((error as Error).message).toBe("API /rounds/backfill failed: 400 backfill_no_layers");
  });

  it("sends the API's camelCase body and reads the recap", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ roundId: "r" }), { status: 200 }));
    const c = createApiClient("https://api.test", async () => "jwt", f as unknown as typeof fetch);
    await c.adminBackfillRound(["a", "b"], [[{ playerId: "a", value: 5 }]]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/rounds/backfill");
    expect(JSON.parse(init.body as string)).toEqual({ participantIds: ["a", "b"], layers: [[{ playerId: "a", value: 5 }]] });
    await c.getRoundRecap("r1");
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe("https://api.test/rounds/r1/recap");
  });
});
