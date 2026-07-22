"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  roomChannelName,
  type LayerTiedPayload,
  type RoundCancelledPayload,
  type RoundClosedPayload,
  type RoundRevealedPayload,
} from "@/lib/supabase/realtime";

type RoomBroadcastPayloadMap = {
  "round-revealed": RoundRevealedPayload;
  "layer-tied": LayerTiedPayload;
  "round-cancelled": RoundCancelledPayload;
  "round-closed": RoundClosedPayload;
};

export type RoomChannelEventHandlers = {
  [K in keyof RoomBroadcastPayloadMap]?: (payload: RoomBroadcastPayloadMap[K]) => void;
};

type SubscribableChannel = {
  on: (
    type: "broadcast",
    filter: { event: string },
    callback: (message: { payload: unknown }) => void,
  ) => SubscribableChannel;
  subscribe: () => unknown;
};

type ChannelClient<T extends SubscribableChannel = SubscribableChannel> = {
  channel: (name: string) => T;
  removeChannel: (channel: T) => unknown;
};

/**
 * Wires up a room's realtime channel, filtering every event to the given
 * roundId before handing the payload to its handler, and returns the
 * cleanup function. Split out from useRoomChannel so the subscribe/filter
 * wiring is a plain function testable without rendering a component.
 */
export function subscribeToRoomChannel<T extends SubscribableChannel>(
  supabase: ChannelClient<T>,
  roomId: string,
  roundId: string,
  handlers: RoomChannelEventHandlers,
): () => void {
  const channel = supabase.channel(roomChannelName(roomId));

  for (const event of Object.keys(handlers) as (keyof RoomBroadcastPayloadMap)[]) {
    const handler = handlers[event] as ((payload: { roundId: string }) => void) | undefined;
    if (!handler) continue;
    channel.on("broadcast", { event }, ({ payload }) => {
      const typedPayload = payload as { roundId: string };
      if (typedPayload.roundId !== roundId) return;
      handler(typedPayload);
    });
  }

  channel.subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribes to a room's Realtime Broadcast channel for the lifetime of the
 * calling component, dispatching each configured event to its handler once
 * filtered to the current roundId, and cleans up on unmount. Replaces the
 * subscribe/filter/cleanup scaffolding that RoundReveal, TieBanner, and
 * RoundOpenLive each used to construct independently (issue #41).
 *
 * Handlers are read from a ref on each event so callers can pass a fresh
 * object every render without re-subscribing the channel.
 */
export function useRoomChannel(
  roomId: string,
  roundId: string,
  handlers: RoomChannelEventHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const supabase = createClient();
    const wrapped: Record<string, (payload: { roundId: string }) => void> = {};
    for (const event of Object.keys(handlersRef.current) as (keyof RoomBroadcastPayloadMap)[]) {
      wrapped[event] = (payload) =>
        (handlersRef.current[event] as ((payload: { roundId: string }) => void) | undefined)?.(payload);
    }

    const unsubscribe = subscribeToRoomChannel(
      supabase,
      roomId,
      roundId,
      wrapped as RoomChannelEventHandlers,
    );

    return unsubscribe;
  }, [roomId, roundId]);
}
