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
  // Test-only helper: the events under test are always registered via `on()`
  // before this is called, so the lookup is safe — this just gives tsc proof
  // of that instead of a possibly-undefined call at each site.
  const getListener = (event: string): BroadcastListener => {
    const listener = listeners[event];
    if (!listener) throw new Error(`no listener registered for "${event}"`);
    return listener;
  };
  return { supabase, channel, listeners, getListener };
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
    const { supabase, getListener } = fakeSupabase();
    const onRevealed = vi.fn();

    subscribeToRoomChannel(supabase, "room-1", "round-1", {
      "round-revealed": onRevealed,
    });

    getListener("round-revealed")({ payload: { roundId: "round-2", brewerId: "p1", cupsMade: 1, rolls: [] } });
    expect(onRevealed).not.toHaveBeenCalled();

    getListener("round-revealed")({ payload: { roundId: "round-1", brewerId: "p1", cupsMade: 1, rolls: [] } });
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("passes every event through unfiltered when roundId is null", () => {
    const { supabase, getListener } = fakeSupabase();
    const onStarted = vi.fn();

    subscribeToRoomChannel(supabase, "room-1", null, {
      "round-started": onStarted,
    });

    getListener("round-started")({ payload: { roundId: "round-1" } });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("subscribes the channel and removes it on cleanup", () => {
    const { supabase, channel } = fakeSupabase();

    const unsubscribe = subscribeToRoomChannel(supabase, "room-1", "round-1", {});
    expect(channel.subscribe).toHaveBeenCalledOnce();

    unsubscribe();
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
  });
});
