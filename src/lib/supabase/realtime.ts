import type { SupabaseClient } from "@supabase/supabase-js";

export function roomChannelName(roomId: string): string {
  return `room:${roomId}`;
}

export type RoundRevealedPayload = {
  roundId: string;
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

export type RoomChangedPayload = {
  version?: number;
};

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
