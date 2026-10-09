import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { broadcastRoomChanged } from "./realtime";

function fakeSupabase(result: { success: boolean; status?: number } = { success: true }) {
  const channel = { httpSend: vi.fn(async () => result) };
  const supabase = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => {}),
  };
  return { supabase: supabase as unknown as SupabaseClient, channel, spies: supabase };
}

describe("broadcastRoomChanged", () => {
  it("sends room-changed with no version on the room's channel (an unported writer has no version to give)", async () => {
    const { supabase, channel, spies } = fakeSupabase();

    await broadcastRoomChanged(supabase, "room-1");

    expect(spies.channel).toHaveBeenCalledWith("room:room-1");
    expect(channel.httpSend).toHaveBeenCalledWith("room-changed", {});
  });

  it("removes the channel after sending", async () => {
    const { supabase, channel, spies } = fakeSupabase();

    await broadcastRoomChanged(supabase, "room-1");

    expect(spies.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("throws when the send fails, and still removes the channel", async () => {
    const { supabase, spies } = fakeSupabase({ success: false, status: 500 });

    await expect(broadcastRoomChanged(supabase, "room-1")).rejects.toThrow("send failed with status 500");
    expect(spies.removeChannel).toHaveBeenCalled();
  });
});
