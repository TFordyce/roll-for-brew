import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApiClient } from "@/lib/api/client";
import { setActingAs } from "./actingAs";
import { enterTodaysRoom } from "./rooms";

type Row = { room_id: string | null; enabled: boolean };

function fake(flags: Row[]) {
  const rpc = vi.fn(async () => ({ data: "room-rpc", error: null }));
  const eq = vi.fn(async () => ({ data: flags, error: null }));
  const from = vi.fn(() => ({ select: () => ({ eq }) }));
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc, eq };
}

const entryApi = () => ({ enterTodaysRoom: vi.fn(async () => ({ roomId: "room-api" })) });
const setApi = () => ({ setActingAs: vi.fn(async () => {}) });

describe("enterTodaysRoom", () => {
  it("keeps the RPC when no flag row exists", async () => {
    const { supabase, rpc, eq } = fake([]);
    const api = entryApi();

    expect(await enterTodaysRoom(supabase, () => api)).toBe("room-rpc");

    expect(eq).toHaveBeenCalledWith("slice", "enterTodaysRoom");
    expect(rpc).toHaveBeenCalledWith("enter_todays_room");
    expect(api.enterTodaysRoom).not.toHaveBeenCalled();
  });

  it("keeps the RPC when the global row is off", async () => {
    const { supabase, rpc } = fake([{ room_id: null, enabled: false }]);

    expect(await enterTodaysRoom(supabase, () => entryApi())).toBe("room-rpc");
    expect(rpc).toHaveBeenCalled();
  });

  it("goes to the API when the global row is on", async () => {
    const { supabase, rpc } = fake([{ room_id: null, enabled: true }]);

    expect(await enterTodaysRoom(supabase, () => entryApi())).toBe("room-api");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ignores a room-scoped row: no room id exists before entry", async () => {
    const { supabase, rpc } = fake([{ room_id: "some-room", enabled: true }]);

    expect(await enterTodaysRoom(supabase, () => entryApi())).toBe("room-rpc");
    expect(rpc).toHaveBeenCalled();
  });
});

describe("setActingAs", () => {
  it("keeps the RPC when no flag row exists", async () => {
    const { supabase, rpc, eq } = fake([]);
    const api = setApi();

    await setActingAs(supabase, "p2", () => api);

    expect(eq).toHaveBeenCalledWith("slice", "setActingAs");
    expect(rpc).toHaveBeenCalledWith("set_acting_as", { p_target_player_id: "p2" });
    expect(api.setActingAs).not.toHaveBeenCalled();
  });

  it("goes to the API when the global row is on", async () => {
    const { supabase, rpc } = fake([{ room_id: null, enabled: true }]);
    const api = setApi();

    await setActingAs(supabase, "p2", () => api);

    expect(api.setActingAs).toHaveBeenCalledWith("p2");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("API client", () => {
  const client = (f: unknown) => createApiClient("https://api.test", async () => "jwt", f as typeof fetch);

  it("POSTs room entry with the Bearer JWT and no client identity", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ roomId: "r1" }), { status: 200 }));

    expect(await client(f).enterTodaysRoom()).toEqual({ roomId: "r1" });

    expect(f).toHaveBeenCalledWith(
      "https://api.test/rooms/today/entry",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer jwt" }) }),
    );
    expect(f.mock.calls[0]).not.toHaveProperty("1.body");
  });

  it("PUTs the target as the only body field of set Acting As", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));

    await client(f).setActingAs("p2");

    expect(f).toHaveBeenCalledWith(
      "https://api.test/acting-as",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ targetPlayerId: "p2" }) }),
    );
  });

  it("surfaces the problem code when set Acting As is refused", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: "admin_required_set_acting_as" }), { status: 403 }));

    await expect(client(f).setActingAs("p2")).rejects.toThrow(/403 admin_required_set_acting_as/);
  });
});
