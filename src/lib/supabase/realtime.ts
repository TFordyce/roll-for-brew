import type { SupabaseClient } from "@supabase/supabase-js";

export function roomChannelName(roomId: string): string {
  return `room:${roomId}`;
}

export type RoundRevealedPayload = {
  roundId: string;
  brewerId: string;
  cupsMade: number;
  rolls: { playerId: string; value: number }[];
};

export type LayerTiedPayload = {
  roundId: string;
  layer: number;
  tiedPlayerIds: string[];
};

export type RoundCancelledPayload = {
  roundId: string;
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
 * Broadcasts a stall-timeout cancellation (issue #21) once cancel_round has
 * committed, so every device drops the round and frees up the "start round"
 * action, the same way broadcastRoundRevealed does for a normal resolution.
 */
export async function broadcastRoundCancelled(
  supabase: SupabaseClient,
  roomId: string,
  payload: RoundCancelledPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("round-cancelled", payload);
    if (!result.success) {
      throw new Error(`broadcastRoundCancelled: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}
