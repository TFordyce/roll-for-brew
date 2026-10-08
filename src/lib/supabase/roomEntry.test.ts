import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "../api/client";
import { setActingAs } from "./actingAs";
import { enterTodaysRoom } from "./rooms";

type Row = { room_id: string | null; enabled: boolean };

function fake(flags: Row[]) {
  const rpc = vi.fn(async () => ({ data: "room-rpc", error: null }));
  const from = vi.fn(() => ({ select: () => ({ eq: async () => ({ data: flags, error: null }) }) }));
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc };
}

const api = () => ({
  enterTodaysRoom: vi.fn(async () => ({ roomId: "room-api" })),
  setActingAs: vi.fn(async () => {}),
}) as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>; // partial fake

describe("enterTodaysRoom", () => {
  it("keeps the RPC when the flag is off", async () => {
    const { supabase, rpc } = fake([]);
    const a = api();
    expect(await enterTodaysRoom(supabase, () => a)).toBe("room-rpc");
    expect(rpc).toHaveBeenCalledWith("enter_todays_room");
    expect(a.enterTodaysRoom).not.toHaveBeenCalled();
  });

  it("goes to the API when the global flag is on", async () => {
    const { supabase, rpc } = fake([{ room_id: null, enabled: true }]);
    const a = api();
    expect(await enterTodaysRoom(supabase, () => a)).toBe("room-api");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ignores a room-scoped row (no room id exists before entry)", async () => {
    const { supabase, rpc } = fake([{ room_id: "some-room", enabled: true }]);
    await enterTodaysRoom(supabase, () => api());
    expect(rpc).toHaveBeenCalled();
  });
});

describe("setActingAs", () => {
  it("keeps the RPC when off", async () => {
    const { supabase, rpc } = fake([]);
    const a = api();
    await setActingAs(supabase, "p2", () => a);
    expect(rpc).toHaveBeenCalledWith("set_acting_as", { p_target_player_id: "p2" });
    expect(a.setActingAs).not.toHaveBeenCalled();
  });

  it("goes to the API when on", async () => {
    const { supabase, rpc } = fake([{ room_id: null, enabled: true }]);
    const a = api();
    await setActingAs(supabase, "p2", () => a);
    expect(a.setActingAs).toHaveBeenCalledWith("p2");
    expect(rpc).not.toHaveBeenCalled();
  });
});
