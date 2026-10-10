import {
  subscribeToRoomChannel,
  type ChannelClient,
  type RoomChannelEventHandlers,
  type SubscribableChannel,
} from "@/lib/supabase/useRoomChannel";

const ANIMATION_EVENTS = [
  "round-revealed",
  "layer-tied",
  "layer-rolls-revealed",
] as const satisfies readonly (keyof RoomChannelEventHandlers)[];

type UnlistedEvent = Exclude<keyof RoomChannelEventHandlers, (typeof ANIMATION_EVENTS)[number] | "room-changed">;
const _everyEventListed: [UnlistedEvent] extends [never] ? true : never = true;
void _everyEventListed;

export function subscribeRoomViewStore<T extends SubscribableChannel>(
  supabase: ChannelClient<T>,
  roomId: string,
  store: { refetch(): void },
  opts: { onResubscribe: () => void },
): () => void {
  const handlers: RoomChannelEventHandlers = {};
  for (const event of [...ANIMATION_EVENTS, "room-changed" as const]) handlers[event] = () => store.refetch();

  return subscribeToRoomChannel(supabase, roomId, null, handlers, opts.onResubscribe);
}
