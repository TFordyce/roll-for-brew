"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  roomChannelName,
  type LayerRollsRevealedPayload,
  type LayerTiedPayload,
  type RoomChangedPayload,
  type RoundRevealedPayload,
} from "@/lib/supabase/realtime";

type RoomBroadcastPayloadMap = {
  "round-revealed": RoundRevealedPayload;
  "layer-tied": LayerTiedPayload;
  "layer-rolls-revealed": LayerRollsRevealedPayload;
  "room-changed": RoomChangedPayload;
};

export type RoomChannelEventHandlers = {
  [K in keyof RoomBroadcastPayloadMap]?: (payload: RoomBroadcastPayloadMap[K]) => void;
};

export type SubscribableChannel = {
  on: (
    type: "broadcast",
    filter: { event: string },
    callback: (message: { payload: unknown }) => void,
  ) => SubscribableChannel;
  subscribe: (callback?: (status: string) => void) => unknown;
};

export type ChannelClient<T extends SubscribableChannel = SubscribableChannel> = {
  channel: (name: string) => T;
  removeChannel: (channel: T) => unknown;
};

export function subscribeToRoomChannel<T extends SubscribableChannel>(
  supabase: ChannelClient<T>,
  roomId: string,
  roundId: string | null,
  handlers: RoomChannelEventHandlers,
  onSubscribed?: () => void,
): () => void {
  const channel = supabase.channel(roomChannelName(roomId));

  for (const event of Object.keys(handlers) as (keyof RoomBroadcastPayloadMap)[]) {
    const handler = handlers[event] as ((payload: { roundId: string }) => void) | undefined;
    if (!handler) continue;
    channel.on("broadcast", { event }, ({ payload }) => {
      const typedPayload = payload as { roundId: string };
      if (event !== "room-changed" && roundId !== null && typedPayload.roundId !== roundId) return;
      handler(typedPayload);
    });
  }

  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") onSubscribed?.();
  });

  return () => {
    supabase.removeChannel(channel);
  };
}

export function useRoomChannel(
  roomId: string,
  roundId: string | null,
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
