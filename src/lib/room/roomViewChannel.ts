import {
  subscribeToRoomChannel,
  type ChannelClient,
  type RoomChannelEventHandlers,
  type SubscribableChannel,
} from "@/lib/supabase/useRoomChannel";

/** The animation events that stay alongside `room-changed` (ADR 0011). Each also means "your view may be stale". */
const ANIMATION_EVENTS = [
  "round-revealed",
  "layer-tied",
  "layer-rolls-revealed",
] as const satisfies readonly (keyof RoomChannelEventHandlers)[];

// A broadcast event added to useRoomChannel but not listed above would silently never refetch.
type UnlistedEvent = Exclude<keyof RoomChannelEventHandlers, (typeof ANIMATION_EVENTS)[number] | "room-changed">;
const _everyEventListed: [UnlistedEvent] extends [never] ? true : never = true;
void _everyEventListed;

/**
 * The room view's single channel listener: hears `room-changed` (sent with a `version` by the API, without one by unported writers)
 * plus the three animation events, unfiltered by round, and refetches. Coalescing and the version rule
 * live in the store: a burst costs one follow-up fetch, and a stale response is dropped there. `onResubscribe` fires on every (re)subscribe.
 */
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
