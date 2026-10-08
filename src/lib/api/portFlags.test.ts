import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPortEnabled } from "./portFlags";
import { createApiClient } from "./client";
import { getActingAsPlayerId } from "../supabase/actingAs";

type Row = { room_id: string | null; enabled: boolean };
function fake(rows: Row[] | null, rpcResult: string | null = "rpc-player") {
  const rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
  const from = vi.fn(() => ({
    select: () => ({ eq: async () => (rows ? { data: rows, error: null } : { data: null, error: { message: "boom" } }) }),
  }));
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc };
}

describe("isPortEnabled", () => {
  it("is off with no row", async () => expect(await isPortEnabled(fake([]).supabase, "s")).toBe(false));
  it("is off when the read fails", async () => expect(await isPortEnabled(fake(null).supabase, "s")).toBe(false));
  it("global row applies to every room and to no room", async () => {
    const { supabase } = fake([{ room_id: null, enabled: true }]);
    expect(await isPortEnabled(supabase, "s")).toBe(true);
    expect(await isPortEnabled(supabase, "s", "room-a")).toBe(true);
  });
  it("room row only applies to its own room", async () => {
    const { supabase } = fake([{ room_id: "room-a", enabled: true }]);
    expect(await isPortEnabled(supabase, "s", "room-a")).toBe(true);
    expect(await isPortEnabled(supabase, "s", "room-b")).toBe(false);
    expect(await isPortEnabled(supabase, "s")).toBe(false);
  });
  it("room row overrides the global row either way", async () => {
    const rows = [{ room_id: null, enabled: true }, { room_id: "room-a", enabled: false }];
    expect(await isPortEnabled(fake(rows).supabase, "s", "room-a")).toBe(false);
    expect(await isPortEnabled(fake(rows).supabase, "s", "room-b")).toBe(true);
  });
});

describe("createApiClient", () => {
  it("sends the JWT as Bearer and parses the body", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ actingAsPlayerId: "p1" }), { status: 200 }));
    const c = createApiClient("https://api.test/", async () => "jwt", f as unknown as typeof fetch);
    expect(await c.getActingAs()).toEqual({ actingAsPlayerId: "p1" });
    expect(f).toHaveBeenCalledWith("https://api.test/acting-as", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer jwt" }) }));
  });
  it("throws on a problem response", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: "unauthenticated" }), { status: 401 }));
    const c = createApiClient("https://api.test", async () => "jwt", f as unknown as typeof fetch);
    await expect(c.getActingAs()).rejects.toThrow(/401 unauthenticated/);
  });
});

describe("getActingAsPlayerId flag branches", () => {
  const api = { getActingAs: vi.fn(async () => ({ actingAsPlayerId: "api-player" as string | null })) };
  it("uses .rpc when the flag is off", async () => {
    const { supabase, rpc } = fake([]);
    expect(await getActingAsPlayerId(supabase, () => api)).toBe("rpc-player");
    expect(rpc).toHaveBeenCalledWith("get_acting_as");
  });
  it("uses the API when the global flag is on", async () => {
    const { supabase, rpc } = fake([{ room_id: null, enabled: true }]);
    expect(await getActingAsPlayerId(supabase, () => api)).toBe("api-player");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rolls back to .rpc when the flag is disabled", async () => {
    const { supabase } = fake([{ room_id: null, enabled: false }]);
    expect(await getActingAsPlayerId(supabase, () => api)).toBe("rpc-player");
  });
});
