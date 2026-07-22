import { describe, expect, it, vi } from "vitest";
import { subscribeToRoomChannel } from "./useRoomChannel";

type BroadcastListener = (message: { payload: unknown }) => void;

function fakeSupabase() {
  const listeners: Record<string, BroadcastListener> = {};
  const channel = {
    on: vi.fn((_type: "broadcast", filter: { event: string }, callback: BroadcastListener) => {
      listeners[filter.event] = callback;
      return channel;
    }),
    subscribe: vi.fn(),
  };
  const supabase = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return { supabase, channel, listeners };
}

describe("subscribeToRoomChannel", () => {
  it("dispatches only the events an event map was given handlers for", () => {
    const { supabase, listeners } = fakeSupabase();
    const onRevealed = vi.fn();

    subscribeToRoomChannel(supabase, "room-1", "round-1", {
      "round-revealed": onRevealed,
    });

    expect(Object.keys(listeners)).toEqual(["round-revealed"]);
  });

  it("filters events to the given roundId", () => {
    const { supabase, listeners } = fakeSupabase();
    const onRevealed = vi.fn();

    subscribeToRoomChannel(supabase, "room-1", "round-1", {
      "round-revealed": onRevealed,
    });

    listeners["round-revealed"]({ payload: { roundId: "round-2", brewerId: "p1", cupsMade: 1, rolls: [] } });
    expect(onRevealed).not.toHaveBeenCalled();

    listeners["round-revealed"]({ payload: { roundId: "round-1", brewerId: "p1", cupsMade: 1, rolls: [] } });
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("subscribes the channel and removes it on cleanup", () => {
    const { supabase, channel } = fakeSupabase();

    const unsubscribe = subscribeToRoomChannel(supabase, "room-1", "round-1", {});
    expect(channel.subscribe).toHaveBeenCalledOnce();

    unsubscribe();
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
  });
});
