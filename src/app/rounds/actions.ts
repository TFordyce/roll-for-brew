"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { closeRound, declareIn, getRoundRoomId, startRound } from "@/lib/supabase/rounds";
import { submitManualRoll, submitRoll } from "@/lib/supabase/rolls";
import { finalizeReactionWindow, resolveCompletedLayerIfAny } from "@/app/rounds/layerResolution";
import { broadcastReactionWindowChanged, broadcastRoundClosed } from "@/lib/supabase/realtime";
import { drawSpellCard, resolveCardSwap } from "@/lib/supabase/spellCards";
import { castSpellCard, endActiveEffect, setSpellCastTarget } from "@/lib/supabase/spellCasts";
import { castReactionSpellCard, passReactionWindow } from "@/lib/supabase/reactionWindow";

/**
 * Draws a spell card if the just-submitted value is a natural 1 or 20
 * (issue #66) — scoped here, at the main round roll's submission, so a
 * card's own resolution roll (e.g. a future counterspell DC check) never
 * triggers a draw (user story 32).
 */
async function maybeDrawSpellCard(
  supabase: Awaited<ReturnType<typeof createClient>>,
  value: number,
) {
  if (value === 1) await drawSpellCard(supabase, "nat1");
  else if (value === 20) await drawSpellCard(supabase, "nat20");
}

/**
 * True for the two submit_roll/submit_manual_roll rejections that mean "the
 * round moved on under you" rather than a real failure — the stall-timeout
 * checker (enforceStallTimeout, src/app/rounds/stallEnforcement.ts) runs
 * lazily on every render, so it can cancel a round or exclude this player
 * from the current layer between the page rendering the roll form and the
 * form actually being submitted. Surfacing that race as a crash (the prior
 * behaviour: throw straight through, no error boundary anywhere in
 * src/app) sent the stalled player to a raw error page for a state change
 * that was correct and expected; refreshing to the room's current state is
 * the right response instead.
 *
 * Keyed off the RFB01/RFB02 Postgres error codes (supabase/migrations/
 * 0013_stale_round_error_codes.sql), not the exception message text — a
 * cosmetic wording change to a `raise exception` string can't silently
 * break this check now. RFB03 (supabase/migrations/0019_spell_casts_pre_roll.sql)
 * extends the same convention to castSpellCardAction/setSpellCastTargetAction:
 * casting/targeting racing against declare-in closing is exactly the same
 * "round moved on under you" shape as a stale roll. RFB04
 * (supabase/migrations/0020_spell_reaction_window.sql) extends it again to
 * castReactionSpellCardAction/passReactionWindowAction: reacting or passing
 * against a window that's already closed (someone else's pass just closed
 * it) is the same race, one layer up. RFB05
 * (supabase/migrations/0023_declare_in_stale_round_error_code.sql) extends
 * it once more to declareInAction: declaring in against a round that
 * close_round already closed between render and submit is the same race,
 * one phase earlier than RFB01.
 */
function isStaleRoundError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "RFB01" ||
    code === "RFB02" ||
    code === "RFB03" ||
    code === "RFB04" ||
    code === "RFB05"
  );
}

/**
 * True for start_round's own version of the same "moved on under you" race:
 * the page only renders the Start Round button when it sees no active
 * round, but two players can both hit that render and submit around the
 * same time. The loser doesn't fail — someone already started the round
 * they meant to start — so treat rounds_one_active_per_room's raw Postgres
 * 23505 (unique_violation) the same way isStaleRoundError treats the RFB0x
 * codes: refresh to current state instead of crashing.
 */
function isRoundAlreadyStartedError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "23505";
}

export async function startRoundAction() {
  const supabase = await createClient();
  try {
    await startRound(supabase);
  } catch (error) {
    if (!isRoundAlreadyStartedError(error)) throw error;
    revalidatePath("/");
    return;
  }
  revalidatePath("/");
}

export async function declareInAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("declareInAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await declareIn(supabase, roundId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }
  revalidatePath("/");
}

export async function closeRoundAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("closeRoundAction: missing roundId");
  }

  const supabase = await createClient();
  await closeRound(supabase, roundId);

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoundClosed(supabase, roomId, { roundId });

  revalidatePath("/");
}

/** Submits the caller's in-app (server-generated) roll for the round's current layer. */
export async function submitRollAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitRollAction: missing roundId");
  }

  const supabase = await createClient();
  let value: number;
  try {
    value = await submitRoll(supabase, roundId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }
  await maybeDrawSpellCard(supabase, value);
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidatePath("/");
}

/**
 * Submits the caller's manually-entered roll for the round's current layer
 * (#22) — the value is trusted client input, range-checked (1-20) by
 * submit_manual_roll itself.
 */
export async function submitManualRollAction(formData: FormData) {
  const roundId = formData.get("roundId");
  const rawValue = formData.get("value");
  const value = typeof rawValue === "string" ? Number(rawValue) : NaN;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("submitManualRollAction: missing roundId");
  }
  if (!Number.isInteger(value)) {
    throw new Error("submitManualRollAction: value must be a whole number");
  }

  const supabase = await createClient();
  try {
    await submitManualRoll(supabase, roundId, value);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }
  await maybeDrawSpellCard(supabase, value);
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidatePath("/");
}

/**
 * Resolves a pending keep-or-swap decision (issue #66, user story 6):
 * keeps either the newly-drawn card or the one already held.
 */
export async function resolveCardSwapAction(formData: FormData) {
  const keepNew = formData.get("keepNew") === "true";

  const supabase = await createClient();
  await resolveCardSwap(supabase, keepNew);
  revalidatePath("/");
}

/**
 * Casts the caller's held Action card for the given round's declare-in
 * window (issue #67). targetPlayerId is omitted to arm an OPPONENT/PLAYER
 * card before the participant roster is final; setSpellCastTargetAction
 * fills it in once declare-in closes.
 */
export async function castSpellCardAction(formData: FormData) {
  const roundId = formData.get("roundId");
  const rawTarget = formData.get("targetPlayerId");
  const targetPlayerId = typeof rawTarget === "string" && rawTarget ? rawTarget : undefined;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("castSpellCardAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await castSpellCard(supabase, roundId, targetPlayerId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }

  revalidatePath("/");
}

/**
 * Fills in the deferred target for a card armed before declare-in closed
 * (issue #67, user story 23) — only valid once the round has closed and the
 * roster is final.
 */
export async function setSpellCastTargetAction(formData: FormData) {
  const castId = formData.get("castId");
  const targetPlayerId = formData.get("targetPlayerId");

  if (typeof castId !== "string" || !castId) {
    throw new Error("setSpellCastTargetAction: missing castId");
  }
  if (typeof targetPlayerId !== "string" || !targetPlayerId) {
    throw new Error("setSpellCastTargetAction: missing targetPlayerId");
  }

  const supabase = await createClient();
  try {
    await setSpellCastTarget(supabase, castId, targetPlayerId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }

  revalidatePath("/");
}

/**
 * Ends another player's active effect early using the caller's currently-
 * held dispel-kind card (Lesser Detox, issue #69) — targets an active
 * effect id rather than a player, so it's a separate action from
 * castSpellCardAction.
 */
export async function endActiveEffectAction(formData: FormData) {
  const roundId = formData.get("roundId");
  const effectId = formData.get("effectId");

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("endActiveEffectAction: missing roundId");
  }
  if (typeof effectId !== "string" || !effectId) {
    throw new Error("endActiveEffectAction: missing effectId");
  }

  const supabase = await createClient();
  try {
    await endActiveEffect(supabase, roundId, effectId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }

  revalidatePath("/");
}

/**
 * Casts the caller's held Reaction card into the round's currently-open
 * reaction window (issue #68) — either reacting to the roll outcome itself
 * (targetCastId omitted) or to another cast on the stack (CARD-target
 * cards). Broadcasts reaction-window-changed so every other device's ribbon
 * banner (ReactionBanner.tsx) re-fetches the reopened poll immediately,
 * rather than waiting for its own next unrelated refresh.
 */
export async function castReactionSpellCardAction(formData: FormData) {
  const roundId = formData.get("roundId");
  const rawTargetPlayer = formData.get("targetPlayerId");
  const targetPlayerId = typeof rawTargetPlayer === "string" && rawTargetPlayer ? rawTargetPlayer : undefined;
  const rawTargetCast = formData.get("targetCastId");
  const targetCastId = typeof rawTargetCast === "string" && rawTargetCast ? rawTargetCast : undefined;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("castReactionSpellCardAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await castReactionSpellCard(supabase, roundId, { targetPlayerId, targetCastId });
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastReactionWindowChanged(supabase, roomId, { roundId });

  revalidatePath("/");
}

/**
 * Passes on the round's currently-open reaction window (issue #68). If this
 * pass closes the window (every currently-eligible Reaction-card holder has
 * now passed in the same poll round), finalizes the layer — applying any
 * active forced-reroll-in-place effects and running the resolution engine —
 * in the same request, then broadcasts the change either way so every
 * device's ribbon banner and dice-reveal screen update in lockstep.
 */
export async function passReactionWindowAction(formData: FormData) {
  const roundId = formData.get("roundId");

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("passReactionWindowAction: missing roundId");
  }

  const supabase = await createClient();
  let closed: boolean;
  try {
    closed = await passReactionWindow(supabase, roundId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidatePath("/");
    return;
  }

  if (closed) {
    await finalizeReactionWindow(supabase, roundId);
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastReactionWindowChanged(supabase, roomId, { roundId });

  revalidatePath("/");
}
