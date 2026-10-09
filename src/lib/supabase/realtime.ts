import type { SupabaseClient } from "@supabase/supabase-js";

export function roomChannelName(roomId: string): string {
  return `room:${roomId}`;
}

export type RoundRevealedPayload = {
  roundId: string;
  // Which layer decided the brewer — 0 for an ordinary round, or a
  // tie-break reroll layer if the round ever tied (issue #220 piece 4).
  // `rolls` below is that layer's rolls, not necessarily layer 0's — a
  // listener that always shows layer 0's own roll (RoundReveal's primary
  // row) needs this to know whether payload.rolls is safe to use for that.
  layer: number;
  brewerId: string;
  cupsMade: number;
  rolls: { playerId: string; value: number; discardedValue: number | null; enteredByAdmin: boolean }[];
  version?: number;
};

export type LayerTiedPayload = {
  roundId: string;
  layer: number;
  tiedPlayerIds: string[];
  version?: number;
};

export type LayerRollsRevealedPayload = {
  roundId: string;
  layer: number;
  rolls: { playerId: string; value: number; discardedValue: number | null; enteredByAdmin: boolean }[];
  version?: number;
};

/**
 * The one refetch hint (ADR 0011): "this room's view may be stale". `version` is the room's
 * `rooms.version` after the write, which only a C# API write inside its transaction can supply; an
 * unported TS/SQL writer sends none and the client's request-sequence rule covers it.
 */
export type RoomChangedPayload = {
  version?: number;
};

/**
 * Broadcasts the simultaneous-reveal event to every device subscribed to
 * the room's Realtime channel, once resolve_round has committed. Uses
 * supabase-js's REST-based broadcast send (httpSend), so the server action
 * doesn't need to hold a live socket open just to publish one message.
 */
export async function broadcastRoundRevealed(
  supabase: SupabaseClient,
  roomId: string,
  payload: RoundRevealedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("round-revealed", payload);
    if (!result.success) {
      throw new Error(`broadcastRoundRevealed: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}

/**
 * Broadcasts a tie transition (issue #20) once advance_round_layer has
 * committed, so every device — tied rerollers and pure spectators alike —
 * swaps the roster for the tie banner in lockstep, the same way
 * broadcastRoundRevealed does for the final reveal.
 */
export async function broadcastLayerTied(
  supabase: SupabaseClient,
  roomId: string,
  payload: LayerTiedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("layer-tied", payload);
    if (!result.success) {
      throw new Error(`broadcastLayerTied: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}

/**
 * Broadcasts a layer's raw rolls the instant they're known — before the
 * reaction window that follows (issue #68) has been opened, let alone
 * closed — so every device flips its dice to the actual values while a
 * reaction is still possible, rather than waiting on round-revealed/
 * layer-tied (which now only fire once the reaction window has closed and
 * any forced-reroll-in-place effects have already been folded in). Carries
 * no brewer/tied-subset yet, since that isn't decided until finalize.
 */
export async function broadcastLayerRollsRevealed(
  supabase: SupabaseClient,
  roomId: string,
  payload: LayerRollsRevealedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("layer-rolls-revealed", payload);
    if (!result.success) {
      throw new Error(`broadcastLayerRollsRevealed: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}

/**
 * Broadcasts that something in the room changed, so every device refetches its view. Replaces the
 * nine refetch-only events (round-started, player-declared-in, spell-cast-changed, ...): the
 * receiver refetches the whole room view either way, so which write happened is not carried. Sent
 * with no `version` -- these writers are unported, and the store's request-sequence rule
 * orders the refetches instead.
 */
export async function broadcastRoomChanged(supabase: SupabaseClient, roomId: string): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("room-changed", {} satisfies RoomChangedPayload);
    if (!result.success) {
      throw new Error(`broadcastRoomChanged: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}
