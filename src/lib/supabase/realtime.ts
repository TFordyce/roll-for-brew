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
