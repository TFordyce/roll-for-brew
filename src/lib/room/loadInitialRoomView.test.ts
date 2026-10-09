import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const isPortEnabled = vi.fn();
const getRoomView = vi.fn();
const apiClientFor = vi.fn(() => ({ getRoomView }));
vi.mock("@/lib/api/portFlags", () => ({ isPortEnabled }));
vi.mock("@/lib/api/client", () => ({ apiClientFor }));

const { loadInitialRoomView } = await import("./loadInitialRoomView");

const supabase = {} as SupabaseClient;
const view = { version: 3, room: { roomId: "room-1" }, viewer: { playerId: "p1" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadInitialRoomView", () => {
  it("returns null without touching the API when room_view is off for the room", async () => {
    isPortEnabled.mockResolvedValue(false);

    expect(await loadInitialRoomView(supabase, "room-1")).toBeNull();
    expect(apiClientFor).not.toHaveBeenCalled();
  });

  it("asks for the room_view flag scoped to this room", async () => {
    isPortEnabled.mockResolvedValue(false);

    await loadInitialRoomView(supabase, "room-9");

    expect(isPortEnabled).toHaveBeenCalledWith(supabase, "room_view", "room-9");
  });

  it("returns the room's view when the flag is on", async () => {
    isPortEnabled.mockResolvedValue(true);
    getRoomView.mockResolvedValue(view);

    expect(await loadInitialRoomView(supabase, "room-1")).toEqual(view);
    expect(getRoomView).toHaveBeenCalledWith("room-1");
  });

  it("falls back to the legacy page (null) when the flagged call fails", async () => {
    isPortEnabled.mockResolvedValue(true);
    getRoomView.mockRejectedValue(new Error("API /rooms/room-1/view failed: 503"));

    expect(await loadInitialRoomView(supabase, "room-1")).toBeNull();
  });

  it("falls back when the API client cannot be built (NEXT_PUBLIC_API_URL unset)", async () => {
    isPortEnabled.mockResolvedValue(true);
    apiClientFor.mockImplementationOnce(() => {
      throw new Error("NEXT_PUBLIC_API_URL must be set");
    });

    expect(await loadInitialRoomView(supabase, "room-1")).toBeNull();
  });
});
