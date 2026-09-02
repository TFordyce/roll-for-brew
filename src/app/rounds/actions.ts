"use server";

import { createClient } from "@/lib/supabase/server";
import {
  closeRound,
  declareIn,
  declareInLate,
  getRoundRoomId,
  startRound,
  withdrawDeclaration,
} from "@/lib/supabase/rounds";
import { submitManualRoll, submitRoll } from "@/lib/supabase/rolls";
import { finalizeReactionWindow, resolveCompletedLayerIfAny } from "@/app/rounds/layerResolution";
import { confirmRoundReplay, declineRoundReplay } from "@/lib/supabase/roundReplay";
import {
  broadcastOrderChanged,
  broadcastPlayerDeclaredIn,
  broadcastPlayerWithdrew,
  broadcastReactionWindowChanged,
  broadcastRoundClosed,
  broadcastRoundReplayChanged,
  broadcastRoundStarted,
  broadcastSpellCastChanged,
} from "@/lib/supabase/realtime";
import {
  drawPendingSpellCard,
  drawPendingSpellCardManual,
  getSpellCardCatalog,
  resolveCardSwap,
} from "@/lib/supabase/spellCards";
import {
  castSpellCard,
  endActiveEffect,
  resolvePendingSpellDieInApp,
  resolvePendingSpellDieManual,
  setSpellCastTarget,
} from "@/lib/supabase/spellCasts";
import { castReactionSpellCard, passReactionWindow } from "@/lib/supabase/reactionWindow";
import {
  afterPendingSpellDieResolved,
  isStaleRoundError,
  maybeRecordPendingSpellDraw,
  resolveSpellCastError,
  revalidateRoundSurfaces,
  type SpellCastActionState,
} from "@/app/rounds/roundActionHelpers";

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

/**
 * roomId is only ever set from the Test Room page's Start Round form
 * (issue #102) — the dateless Test Room can't be found by start_round's
 * default today's-date lookup, so that form passes its id explicitly.
 * Real gameplay's form has no such hidden field, so this stays undefined
 * there and today's room is resolved exactly as before.
 */
export async function startRoundAction(formData: FormData) {
  const rawRoomId = formData.get("roomId");
  const targetRoomId = typeof rawRoomId === "string" && rawRoomId ? rawRoomId : undefined;

  const supabase = await createClient();
  let roundId: string;
  try {
    roundId = await startRound(supabase, targetRoomId);
  } catch (error) {
    if (!isRoundAlreadyStartedError(error)) throw error;
    revalidateRoundSurfaces();
    return;
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoundStarted(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
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
    revalidateRoundSurfaces();
    return;
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastPlayerDeclaredIn(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
}

/**
 * Declares the caller in after the round has already closed (issue #246,
 * the "Late Declare" glossary entry, CONTEXT.md) — only valid up to the
 * round's first submitted roll (declare_in_late, 0068). Broadcasts both
 * player-declared-in, same as declareInAction, so the closed-round view
 * (RoundReveal) picks up the new participant, and spell-cast-changed, so any
 * still-deferred (null-target) Action-card cast becomes targetable at them
 * without a manual reload.
 */
export async function declareInLateAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("declareInLateAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await declareInLate(supabase, roundId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidateRoundSurfaces();
    return;
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastPlayerDeclaredIn(supabase, roomId, { roundId });
  await broadcastSpellCastChanged(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
}

/** Undoes an accidental "I'm in" (declareInAction) while the round is still open. */
export async function withdrawDeclarationAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("withdrawDeclarationAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await withdrawDeclaration(supabase, roundId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidateRoundSurfaces();
    return;
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastPlayerWithdrew(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
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

  revalidateRoundSurfaces();
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
    revalidateRoundSurfaces();
    return;
  }
  await maybeRecordPendingSpellDraw(supabase, value, roundId);
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidateRoundSurfaces();
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
    revalidateRoundSurfaces();
    return;
  }
  await maybeRecordPendingSpellDraw(supabase, value, roundId);
  await resolveCompletedLayerIfAny(supabase, roundId);

  revalidateRoundSurfaces();
}

/**
 * Resolves a Pending Spell Die (issue #252) with the app's own
 * server-generated roll — the dice_modifier counterpart to submitRollAction.
 * afterPendingSpellDieResolved re-enters layer resolution afterward, since
 * get_current_layer_rolls_if_complete's gate (0069) may have been blocking
 * on exactly this cast the whole time it sat pending.
 */
export async function resolvePendingSpellDieInAppAction(formData: FormData) {
  const roundId = formData.get("roundId");
  const castId = formData.get("castId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("resolvePendingSpellDieInAppAction: missing roundId");
  }
  if (typeof castId !== "string" || !castId) {
    throw new Error("resolvePendingSpellDieInAppAction: missing castId");
  }

  const supabase = await createClient();
  try {
    await resolvePendingSpellDieInApp(supabase, castId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidateRoundSurfaces();
    return;
  }
  await afterPendingSpellDieResolved(supabase, roundId);

  revalidateRoundSurfaces();
}

/**
 * Resolves a Pending Spell Die (issue #252) with a value the player
 * physically rolled — the dice_modifier counterpart to
 * submitManualRollAction. The value is trusted client input, range-checked
 * against the card's own dice spec by resolve_pending_spell_die_manual
 * itself; a failed check comes back as an inline typed error
 * (resolveSpellCastError) rather than the root error boundary, same as the
 * spell-cast form actions.
 */
export async function resolvePendingSpellDieManualAction(
  _prevState: SpellCastActionState,
  formData: FormData,
): Promise<SpellCastActionState> {
  const roundId = formData.get("roundId");
  const castId = formData.get("castId");
  const rawValue = formData.get("value");
  const value = typeof rawValue === "string" ? Number(rawValue) : NaN;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("resolvePendingSpellDieManualAction: missing roundId");
  }
  if (typeof castId !== "string" || !castId) {
    throw new Error("resolvePendingSpellDieManualAction: missing castId");
  }
  if (!Number.isInteger(value)) {
    return { status: "error", message: "Enter the whole number you rolled." };
  }

  const supabase = await createClient();
  try {
    await resolvePendingSpellDieManual(supabase, castId, value);
  } catch (error) {
    return resolveSpellCastError(error);
  }
  await afterPendingSpellDieResolved(supabase, roundId);

  revalidateRoundSurfaces();
  return { status: "idle" };
}

/**
 * Resolves a pending keep-or-swap decision (issue #66, user story 6):
 * keeps either the newly-drawn card or the one already held.
 *
 * If this decision drops the resolving player out of Reaction-card
 * eligibility and they were the round's currently-open reaction window's
 * last eligible holder, resolve_card_swap (0064, issue #251) closes that
 * window and hands back its round id — finalizing the layer in the same
 * request the way passReactionWindowAction's own "if closed, finalize" does
 * below, so the round doesn't get stuck waiting on a player who no longer
 * has anything to react with. Unlike that action, there's nothing to
 * broadcast on the non-closing path here — a swap that doesn't change
 * eligibility never touches the window at all.
 */
export async function resolveCardSwapAction(formData: FormData) {
  const keepNew = formData.get("keepNew") === "true";
  const rawRoomId = formData.get("roomId");
  const roomId = typeof rawRoomId === "string" && rawRoomId ? rawRoomId : undefined;

  const supabase = await createClient();
  const closedRoundId = await resolveCardSwap(supabase, keepNew, roomId);

  if (closedRoundId) {
    await finalizeReactionWindow(supabase, closedRoundId);
    if (roomId) {
      await broadcastReactionWindowChanged(supabase, roomId, { roundId: closedRoundId });
    }
  }

  revalidateRoundSurfaces();
}

/**
 * Resolves a pending spell draw (the "how did you draw?" prompt,
 * SpellDrawChoicePanel.tsx) with the app's own uniformly-random draw —
 * the "draw in-app" choice.
 */
export async function drawPendingSpellCardAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("drawPendingSpellCardAction: missing roundId");
  }

  const supabase = await createClient();
  await drawPendingSpellCard(supabase, roundId);
  revalidateRoundSurfaces();
}

export type DrawPendingSpellCardManualState = { status: "idle" } | { status: "error"; message: string };

/**
 * Resolves a pending spell draw with the specific card the caller says
 * they physically drew from the real deck ("players will definitely
 * prefer drawing from the deck IRL"). The name is trusted client input,
 * matched case/whitespace-insensitively against the catalog — same
 * "trusted, no verification" posture as manual dice entry
 * (submit_manual_roll) — but the RPC still re-checks that card actually
 * has a drawable in-deck instance (RFB06 if not), so a typo or a physical/
 * digital desync surfaces as a retryable message rather than corrupting
 * deck state.
 */
export async function drawPendingSpellCardManualAction(
  _prevState: DrawPendingSpellCardManualState,
  formData: FormData,
): Promise<DrawPendingSpellCardManualState> {
  const roundId = formData.get("roundId");
  const rawCardName = formData.get("cardName");
  const cardName = typeof rawCardName === "string" ? rawCardName.trim() : "";

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("drawPendingSpellCardManualAction: missing roundId");
  }
  if (!cardName) {
    return { status: "error", message: "Type the name of the card you drew." };
  }

  const supabase = await createClient();
  const catalog = await getSpellCardCatalog(supabase);
  const normalized = cardName.toLowerCase();
  const match = catalog.find((c) => c.name.toLowerCase() === normalized);

  if (!match) {
    return { status: "error", message: `No card in the deck is named "${cardName}" — check the spelling.` };
  }

  try {
    await drawPendingSpellCardManual(supabase, roundId, match.cardId);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "RFB06") {
      return {
        status: "error",
        message: `${match.name} isn't currently in the deck (already held, or already drawn) — check with your table.`,
      };
    }
    throw error;
  }

  revalidateRoundSurfaces();
  return { status: "idle" };
}

/**
 * Casts the caller's held Action card for the given round's declare-in
 * window (issue #67). targetPlayerId is omitted to arm an OPPONENT/PLAYER
 * card before the participant roster is final; setSpellCastTargetAction
 * fills it in once declare-in closes. Broadcasts spell-cast-changed (issue
 * #205) so other players — who may now be targeted, or see a new active
 * effect — pick it up without a manual reload.
 */
export async function castSpellCardAction(
  _prevState: SpellCastActionState,
  formData: FormData,
): Promise<SpellCastActionState> {
  const roundId = formData.get("roundId");
  const rawTarget = formData.get("targetPlayerId");
  const targetPlayerId = typeof rawTarget === "string" && rawTarget ? rawTarget : undefined;
  const chosenPlayerIds = formData.getAll("chosenPlayerIds").filter((v): v is string => typeof v === "string" && v.length > 0);
  const rawDeclaredNumber = formData.get("declaredNumber");
  const declaredNumber =
    typeof rawDeclaredNumber === "string" && rawDeclaredNumber ? Number(rawDeclaredNumber) : undefined;

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("castSpellCardAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await castSpellCard(supabase, roundId, {
      targetPlayerId,
      chosenPlayerIds: chosenPlayerIds.length > 0 ? chosenPlayerIds : undefined,
      declaredNumber,
    });
  } catch (error) {
    return resolveSpellCastError(error);
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastSpellCastChanged(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
  return { status: "idle" };
}

/**
 * Fills in the deferred target for a card armed before declare-in closed
 * (issue #67, user story 23) — only valid once the round has closed and the
 * roster is final. Broadcasts spell-cast-changed (issue #205) since this
 * changes the caster/target/advantage data other players see in RoundReveal
 * (PR #176).
 */
export async function setSpellCastTargetAction(
  _prevState: SpellCastActionState,
  formData: FormData,
): Promise<SpellCastActionState> {
  const castId = formData.get("castId");
  const targetPlayerId = formData.get("targetPlayerId");
  const roundId = formData.get("roundId");

  if (typeof castId !== "string" || !castId) {
    throw new Error("setSpellCastTargetAction: missing castId");
  }
  if (typeof targetPlayerId !== "string" || !targetPlayerId) {
    throw new Error("setSpellCastTargetAction: missing targetPlayerId");
  }
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("setSpellCastTargetAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await setSpellCastTarget(supabase, castId, targetPlayerId);
  } catch (error) {
    return resolveSpellCastError(error);
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastSpellCastChanged(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
  return { status: "idle" };
}

/**
 * Ends another player's active effect early using the caller's currently-
 * held dispel-kind card (Lesser Detox, issue #69) — targets an active
 * effect id rather than a player, so it's a separate action from
 * castSpellCardAction. Broadcasts spell-cast-changed (issue #205) so the
 * dispelled player sees their effect end without a manual reload.
 */
export async function endActiveEffectAction(
  _prevState: SpellCastActionState,
  formData: FormData,
): Promise<SpellCastActionState> {
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
    return resolveSpellCastError(error);
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastSpellCastChanged(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
  return { status: "idle" };
}

/**
 * Casts the caller's held Reaction card into the round's currently-open
 * reaction window (issue #68) — either reacting to the roll outcome itself
 * (targetCastId omitted) or to another cast on the stack (CARD-target
 * cards). Broadcasts reaction-window-changed so every other device's ribbon
 * banner (ReactionBanner.tsx) re-fetches the reopened poll immediately,
 * rather than waiting for its own next unrelated refresh.
 */
export async function castReactionSpellCardAction(
  _prevState: SpellCastActionState,
  formData: FormData,
): Promise<SpellCastActionState> {
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
    return resolveSpellCastError(error);
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastReactionWindowChanged(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
  return { status: "idle" };
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
    revalidateRoundSurfaces();
    return;
  }

  if (closed) {
    await finalizeReactionWindow(supabase, roundId);
  }

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastReactionWindowChanged(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
}

/**
 * Broadcasts a round's Menu changing (issue #227) — called by OrderPicker
 * right after submit_order itself succeeds. submit_order is invoked
 * directly from the browser client (same immediate-tap pattern
 * BrewRatingPanel uses, per issue #226), not through a form action, so
 * unlike every other write in this file the mutation itself already
 * happened by the time this runs; this action's only job is the broadcast
 * plus revalidation every other write here gets for free via its own
 * server-side mutation. Deliberately does not re-derive or re-validate the
 * Order itself — submit_order already did that server-side, and this is
 * best-effort notification, not the write path.
 */
export async function notifyOrderChangedAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("notifyOrderChangedAction: missing roundId");
  }

  const supabase = await createClient();
  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastOrderChanged(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
}

/**
 * The Time for Brew caster scraps the just-announced round (issue #315, spec
 * §11). confirm_round_replay runs _rr_scrap_round — the round is backed out
 * to a freshly-closed generation-1 round awaiting rolls — then this broadcasts
 * round-closed (every device re-enters the roll phase) and
 * round-replay-changed (the blocking prompt clears).
 */
export async function confirmRoundReplayAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("confirmRoundReplayAction: missing roundId");
  }

  const supabase = await createClient();
  const roomId = await getRoundRoomId(supabase, roundId);
  await confirmRoundReplay(supabase, roundId);
  await broadcastRoundReplayChanged(supabase, roomId, { roundId });
  await broadcastRoundClosed(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
}

/**
 * The Time for Brew caster keeps the just-announced round (issue #315). The
 * round stands, the card is spent. Idempotent — a race with the stall
 * auto-decline is fine.
 */
export async function declineRoundReplayAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("declineRoundReplayAction: missing roundId");
  }

  const supabase = await createClient();
  const roomId = await getRoundRoomId(supabase, roundId);
  await declineRoundReplay(supabase, roundId);
  await broadcastRoundReplayChanged(supabase, roomId, { roundId });

  revalidateRoundSurfaces();
}
