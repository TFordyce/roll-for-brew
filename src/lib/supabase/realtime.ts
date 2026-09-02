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
};

export type LayerTiedPayload = {
  roundId: string;
  layer: number;
  tiedPlayerIds: string[];
};

export type RoundCancelledPayload = {
  roundId: string;
};

export type RoundClosedPayload = {
  roundId: string;
};

export type LayerRollsRevealedPayload = {
  roundId: string;
  layer: number;
  rolls: { playerId: string; value: number; discardedValue: number | null; enteredByAdmin: boolean }[];
};

export type ReactionWindowChangedPayload = {
  roundId: string;
};

export type PlayerDeclaredInPayload = {
  roundId: string;
};

export type PlayerWithdrewPayload = {
  roundId: string;
};

export type RoundStartedPayload = {
  roundId: string;
};

export type SpellCastChangedPayload = {
  roundId: string;
};

export type OrderChangedPayload = {
  roundId: string;
};

export type RoundReplayChangedPayload = {
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
 * Broadcasts declarations closing (rolling begins) once close_round has
 * committed, so every declared-in player still sitting on the "open" view —
 * which has no other realtime listener of its own, unlike the closed-phase
 * RoundReveal/TieBanner — finds out it's their turn to roll without needing
 * to manually reload.
 */
export async function broadcastRoundClosed(
  supabase: SupabaseClient,
  roomId: string,
  payload: RoundClosedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("round-closed", payload);
    if (!result.success) {
      throw new Error(`broadcastRoundClosed: send failed with status ${result.status}`);
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
 * Broadcasts that the round's reaction-window state changed (opened, a new
 * reaction was cast into it, or it closed) — the ribbon banner
 * (ReactionBanner.tsx) listens for this to refresh its own state. One event
 * name covers all three: the banner just re-fetches get_open_reaction_window/
 * get_reaction_stack rather than trying to reconstruct state from the
 * broadcast payload, since it needs a fresh read either way.
 */
export async function broadcastReactionWindowChanged(
  supabase: SupabaseClient,
  roomId: string,
  payload: ReactionWindowChangedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("reaction-window-changed", payload);
    if (!result.success) {
      throw new Error(`broadcastReactionWindowChanged: send failed with status ${result.status}`);
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

/**
 * Broadcasts a declaration once declare_in has committed (issue #98), so
 * every device still sitting on the "open"/"Who's In?" view — which already
 * listens via RoundOpenLive — sees the updated roster and "Need N more to
 * roll" count without a manual reload, the same way broadcastRoundClosed
 * covers the next transition on that same view.
 */
export async function broadcastPlayerDeclaredIn(
  supabase: SupabaseClient,
  roomId: string,
  payload: PlayerDeclaredInPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("player-declared-in", payload);
    if (!result.success) {
      throw new Error(`broadcastPlayerDeclaredIn: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}

/**
 * Broadcasts a withdrawal once withdraw_declaration has committed — the
 * "cancel an accidental declare" counterpart to broadcastPlayerDeclaredIn,
 * covering the same "Who's In?" view for the roster/"Need N more" update in
 * the other direction.
 */
export async function broadcastPlayerWithdrew(
  supabase: SupabaseClient,
  roomId: string,
  payload: PlayerWithdrewPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("player-withdrew", payload);
    if (!result.success) {
      throw new Error(`broadcastPlayerWithdrew: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}

/**
 * Broadcasts a round starting once start_round has committed (issue #98), so
 * every device sitting on the idle "Start Round" view — which previously had
 * no realtime listener at all — picks up the new round without a manual
 * reload.
 */
export async function broadcastRoundStarted(
  supabase: SupabaseClient,
  roomId: string,
  payload: RoundStartedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("round-started", payload);
    if (!result.success) {
      throw new Error(`broadcastRoundStarted: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}

/**
 * Broadcasts a change to a round's spell-cast/active-effect state (issue
 * #205) — casting an Action card, filling in a deferred target, or ending
 * another player's active effect early all change what other players see
 * (caster/target/advantage in RoundReveal per PR #176, effect badges on
 * PlayerTile, the dispellable-effects list on their own SpellCardPanel), but
 * previously had no broadcast at all. One event covers all three causes —
 * mirrors broadcastReactionWindowChanged's approach — since the receiving
 * side (SpellCastLive.tsx) just refreshes the server component tree rather
 * than trying to reconstruct state from the payload.
 */
export async function broadcastSpellCastChanged(
  supabase: SupabaseClient,
  roomId: string,
  payload: SpellCastChangedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("spell-cast-changed", payload);
    if (!result.success) {
      throw new Error(`broadcastSpellCastChanged: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}

/**
 * Broadcasts a change to a round's Menu (issue #227) once submit_order has
 * committed — picking or changing an Order previously had no broadcast at
 * all, so the live Menu (RoundMenu.tsx, via MenuLive.tsx) went stale until a
 * manual reload. Same one-event/just-refetch shape as
 * broadcastSpellCastChanged/broadcastReactionWindowChanged: the receiving
 * side re-fetches round_menu rather than trying to reconstruct it from the
 * payload.
 */
export async function broadcastOrderChanged(
  supabase: SupabaseClient,
  roomId: string,
  payload: OrderChangedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("order-changed", payload);
    if (!result.success) {
      throw new Error(`broadcastOrderChanged: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}

/**
 * Broadcasts that a round's replay decision changed (issue #315): a
 * pending_round_replay row was created (Time for Brew survived the reaction
 * window and its round just resolved), confirmed (round scrapped, generation
 * 1 begins), declined, or auto-declined by the stall sweep. Same
 * one-event/just-refetch shape as the other room broadcasts — RoundReplayPrompt
 * (and RoundReveal, which is what's mounted at announce time) re-renders the
 * server tree so the blocking prompt / "waiting on X" banner appears or clears
 * in lockstep on every device.
 */
export async function broadcastRoundReplayChanged(
  supabase: SupabaseClient,
  roomId: string,
  payload: RoundReplayChangedPayload,
): Promise<void> {
  const channel = supabase.channel(roomChannelName(roomId));
  try {
    const result = await channel.httpSend("round-replay-changed", payload);
    if (!result.success) {
      throw new Error(`broadcastRoundReplayChanged: send failed with status ${result.status}`);
    }
  } finally {
    await supabase.removeChannel(channel);
  }
}
