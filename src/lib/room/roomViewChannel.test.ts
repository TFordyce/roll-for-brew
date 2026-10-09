import { describe, expect, it, vi } from "vitest";
import { subscribeRoomViewStore } from "./roomViewChannel";

type BroadcastListener = (message: { payload: unknown }) => void;
type SubscribeStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";

function fakeSupabase() {
  const listeners: Record<string, BroadcastListener> = {};
  let onStatus: ((status: SubscribeStatus) => void) | undefined;
  const channel = {
    on: vi.fn((_type: "broadcast", filter: { event: string }, callback: BroadcastListener) => {
      listeners[filter.event] = callback;
      return channel;
    }),
    subscribe: vi.fn((cb?: (status: SubscribeStatus) => void) => {
      onStatus = cb;
    }),
  };
  const supabase = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
  return {
    supabase,
    channel,
    listeners,
    emit: (event: string, payload: unknown) => {
      const l = listeners[event];
      if (!l) throw new Error(`no listener for "${event}"`);
      l({ payload });
    },
    status: (s: SubscribeStatus) => onStatus?.(s),
  };
}

function fakeStore(version: number) {
  return { getSnapshot: () => ({ version }) as never, refetch: vi.fn() };
}

// The twelve events the eight *Live components listened for, written out independently of the code.
const OLD_EVENTS = [
  "round-revealed",
  "layer-tied",
  "round-cancelled",
  "round-closed",
  "layer-rolls-revealed",
  "reaction-window-changed",
  "player-declared-in",
  "player-withdrew",
  "round-started",
  "spell-cast-changed",
  "order-changed",
  "round-replay-changed",
];

describe("subscribeRoomViewStore", () => {
  it("listens on the room's channel for the old event names and room-changed, with no round filter", () => {
    const { supabase, listeners } = fakeSupabase();
    subscribeRoomViewStore(supabase, "room-1", fakeStore(1), { onResubscribe: () => {} });

    expect(supabase.channel).toHaveBeenCalledWith("room:room-1");
    expect([...Object.keys(listeners)].sort()).toEqual([...OLD_EVENTS, "room-changed"].sort());
  });

  it.each(OLD_EVENTS)("refetches on %s, whichever round it names", (event) => {
    const { supabase, emit } = fakeSupabase();
    const store = fakeStore(1);
    subscribeRoomViewStore(supabase, "room-1", store, { onResubscribe: () => {} });

    emit(event, { roundId: "any-round" });

    expect(store.refetch).toHaveBeenCalledTimes(1);
  });

  it("refetches on a room-changed whose version is ahead of the held view", () => {
    const { supabase, emit } = fakeSupabase();
    const store = fakeStore(4);
    subscribeRoomViewStore(supabase, "room-1", store, { onResubscribe: () => {} });

    emit("room-changed", { version: 5 });

    expect(store.refetch).toHaveBeenCalledTimes(1);
  });

  it("ignores a room-changed the held view already covers", () => {
    const { supabase, emit } = fakeSupabase();
    const store = fakeStore(5);
    subscribeRoomViewStore(supabase, "room-1", store, { onResubscribe: () => {} });

    emit("room-changed", { version: 5 });
    emit("room-changed", { version: 3 });

    expect(store.refetch).not.toHaveBeenCalled();
  });

  it("refetches on a room-changed that carries no usable version", () => {
    const { supabase, emit } = fakeSupabase();
    const store = fakeStore(5);
    subscribeRoomViewStore(supabase, "room-1", store, { onResubscribe: () => {} });

    emit("room-changed", {});

    expect(store.refetch).toHaveBeenCalledTimes(1);
  });

  it("asks for a resync each time the channel (re)subscribes, and for nothing else", () => {
    const { supabase, status } = fakeSupabase();
    const onResubscribe = vi.fn();
    subscribeRoomViewStore(supabase, "room-1", fakeStore(1), { onResubscribe });

    status("SUBSCRIBED");
    status("CHANNEL_ERROR");
    status("CLOSED");
    status("SUBSCRIBED");

    expect(onResubscribe).toHaveBeenCalledTimes(2);
  });

  it("removes the channel on cleanup", () => {
    const { supabase, channel } = fakeSupabase();
    const unsubscribe = subscribeRoomViewStore(supabase, "room-1", fakeStore(1), { onResubscribe: () => {} });

    unsubscribe();

    expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
  });
});
