import {
  subscribeToRoomChannel,
  type ChannelClient,
  type RoomChannelEventHandlers,
  type SubscribableChannel,
} from "@/lib/supabase/useRoomChannel";

/** The events the eight `*Live` refreshes listened for. Each means "your view may be stale". */
const LEGACY_EVENTS = [
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
] as const satisfies readonly (keyof RoomChannelEventHandlers)[];

// A broadcast event added to useRoomChannel but not listed above would silently never refetch.
type UnlistedEvent = Exclude<keyof RoomChannelEventHandlers, (typeof LEGACY_EVENTS)[number] | "room-changed">;
const _everyEventListed: [UnlistedEvent] extends [never] ? true : never = true;
void _everyEventListed;

/**
 * The room view's single channel listener: hears every legacy event name plus the API's
 * `room-changed { version }`, unfiltered by round, and refetches. Coalescing and the version rule
 * live in the store: a burst costs one follow-up fetch, and a stale response is dropped there. `onResubscribe` fires on every (re)subscribe.
 */
export function subscribeRoomViewStore<T extends SubscribableChannel>(
  supabase: ChannelClient<T>,
  roomId: string,
  store: { refetch(): void },
  opts: { onResubscribe: () => void },
): () => void {
  const handlers: RoomChannelEventHandlers = {};
  for (const event of [...LEGACY_EVENTS, "room-changed" as const]) handlers[event] = () => store.refetch();

  return subscribeToRoomChannel(supabase, roomId, null, handlers, opts.onResubscribe);
}
