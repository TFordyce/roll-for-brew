import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApiClient } from "@/lib/api/client";
import { setActingAs } from "./actingAs";
import { enterTodaysRoom } from "./rooms";

// Room entry and Acting As go to the API only: any Supabase call would be a regression to the
// retired RPCs, so the client is a Proxy that fails the test on first touch.
const supabase = new Proxy({}, {
  get: (_target, prop) => {
    throw new Error(`unexpected supabase.${String(prop)}`);
  },
}) as unknown as SupabaseClient;

describe("enterTodaysRoom", () => {
  it("enters through the API and returns its room id", async () => {
    const api = { enterTodaysRoom: vi.fn(async () => ({ roomId: "room-api" })) };

    expect(await enterTodaysRoom(supabase, () => api)).toBe("room-api");
    expect(api.enterTodaysRoom).toHaveBeenCalledOnce();
  });

  it("lets an API failure through", async () => {
    const api = { enterTodaysRoom: vi.fn(async () => { throw new Error("API /rooms/today/entry failed: 503"); }) };

    await expect(enterTodaysRoom(supabase, () => api)).rejects.toThrow("503");
  });
});

describe("setActingAs", () => {
  it("sets Acting As through the API", async () => {
    const api = { setActingAs: vi.fn(async () => {}) };

    await setActingAs(supabase, "p2", () => api);

    expect(api.setActingAs).toHaveBeenCalledWith("p2");
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
