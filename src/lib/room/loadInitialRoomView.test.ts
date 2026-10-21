import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const getRoomView = vi.fn();
const apiClientFor = vi.fn(() => ({ getRoomView }));
vi.mock("@/lib/api/client", () => ({ apiClientFor }));

const { loadInitialRoomView } = await import("./loadInitialRoomView");

const supabase = {} as SupabaseClient;
const view = { version: 3, room: { roomId: "room-1" }, viewer: { playerId: "p1" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadInitialRoomView", () => {
  it("returns the room's view from the API", async () => {
    getRoomView.mockResolvedValue(view);

    expect(await loadInitialRoomView(supabase, "room-1")).toEqual(view);
    expect(getRoomView).toHaveBeenCalledWith("room-1");
  });

  it("lets an API failure propagate: there is no legacy page to fall back to", async () => {
    getRoomView.mockRejectedValue(new Error("API /rooms/room-1/view failed: 503"));

    await expect(loadInitialRoomView(supabase, "room-1")).rejects.toThrow("503");
  });
});
