import {
  subscribeToRoomChannel,
  type ChannelClient,
  type RoomChannelEventHandlers,
  type SubscribableChannel,
} from "@/lib/supabase/useRoomChannel";
import type { RoomView } from "./roomViewStore";

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
 * `room-changed { version }`, unfiltered by round, and refetches. Coalescing lives in the store, so
 * a burst of events costs one follow-up fetch. `onResubscribe` fires on every (re)subscribe.
 */
export function subscribeRoomViewStore<T extends SubscribableChannel>(
  supabase: ChannelClient<T>,
  roomId: string,
  store: { getSnapshot(): RoomView; refetch(): void },
  opts: { onResubscribe: () => void },
): () => void {
  const handlers: RoomChannelEventHandlers = {
    "room-changed": (payload) => {
      const announced = Number((payload as { version?: unknown }).version);
      // A version we already hold needs no fetch; a missing one can't be judged, so fetch.
      if (Number.isFinite(announced) && announced <= Number(store.getSnapshot().version)) return;
      store.refetch();
    },
  };
  for (const event of LEGACY_EVENTS) handlers[event] = () => store.refetch();

  return subscribeToRoomChannel(supabase, roomId, null, handlers, opts.onResubscribe);
}
