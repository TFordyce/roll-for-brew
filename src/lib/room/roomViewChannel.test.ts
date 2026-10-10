import { describe, expect, it, vi } from "vitest";
import { subscribeRoomViewStore } from "./roomViewChannel";
import { createRoomViewStore, type RoomView } from "./roomViewStore";

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

function fakeStore() {
  return { refetch: vi.fn() };
}

const ANIMATION_EVENTS = ["round-revealed", "layer-tied", "layer-rolls-revealed"];

const RETIRED_EVENTS = [
  "round-cancelled",
  "round-closed",
  "reaction-window-changed",
  "player-declared-in",
  "player-withdrew",
  "round-started",
  "spell-cast-changed",
  "order-changed",
  "round-replay-changed",
];

describe("subscribeRoomViewStore", () => {
  it("listens on the room's channel for room-changed and the three animation events, with no round filter", () => {
    const { supabase, listeners } = fakeSupabase();
    subscribeRoomViewStore(supabase, "room-1", fakeStore(), { onResubscribe: () => {} });

    expect(supabase.channel).toHaveBeenCalledWith("room:room-1");
    expect([...Object.keys(listeners)].sort()).toEqual([...ANIMATION_EVENTS, "room-changed"].sort());
    for (const retired of RETIRED_EVENTS) expect(listeners).not.toHaveProperty(retired);
  });

  it.each(ANIMATION_EVENTS)("refetches on %s, whichever round it names", (event) => {
    const { supabase, emit } = fakeSupabase();
    const store = fakeStore();
    subscribeRoomViewStore(supabase, "room-1", store, { onResubscribe: () => {} });

    emit(event, { roundId: "any-round" });

    expect(store.refetch).toHaveBeenCalledTimes(1);
  });

  it("refetches on every room-changed, whatever version it announces (the store drops stale responses itself)", () => {
    const { supabase, emit } = fakeSupabase();
    const store = fakeStore();
    subscribeRoomViewStore(supabase, "room-1", store, { onResubscribe: () => {} });

    emit("room-changed", { version: 5 });
    emit("room-changed", { version: 1 });
    emit("room-changed", {});

    expect(store.refetch).toHaveBeenCalledTimes(3);
  });

  it("asks for a resync each time the channel (re)subscribes, and for nothing else", () => {
    const { supabase, status } = fakeSupabase();
    const onResubscribe = vi.fn();
    subscribeRoomViewStore(supabase, "room-1", fakeStore(), { onResubscribe });

    status("SUBSCRIBED");
    status("CHANNEL_ERROR");
    status("CLOSED");
    status("SUBSCRIBED");

    expect(onResubscribe).toHaveBeenCalledTimes(2);
  });

  it("removes the channel on cleanup", () => {
    const { supabase, channel } = fakeSupabase();
    const unsubscribe = subscribeRoomViewStore(supabase, "room-1", fakeStore(), { onResubscribe: () => {} });

    unsubscribe();

    expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("applies a versionless room-changed's refetch: the store's request-sequence rule covers unported writers", async () => {
    const view = (version: number, marker: string) => ({ version, marker }) as unknown as RoomView;
    const fetchView = vi.fn(async () => view(5, "after-unported-write"));
    const store = createRoomViewStore({ initialView: view(5, "before"), fetchView });
    const { supabase, emit } = fakeSupabase();
    subscribeRoomViewStore(supabase, "room-1", store, { onResubscribe: () => {} });

    emit("room-changed", {});
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ marker: "after-unported-write" }));
    expect(fetchView).toHaveBeenCalledTimes(1);
  });
});
