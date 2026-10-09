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
import { advanceRound } from "@/app/rounds/advanceRound";
import { confirmRoundReplay, declineRoundReplay } from "@/lib/supabase/roundReplay";
import { broadcastRoomChanged } from "@/lib/supabase/realtime";
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
  setTeaPartyRevoltTarget,
} from "@/lib/supabase/spellCasts";
import {
  castReactionSpellCard,
  passReactionWindow,
  spendCourageToken,
  voteSkipReactionWindow,
} from "@/lib/supabase/reactionWindow";
import {
  isStaleRoundError,
  maybeRecordPendingSpellDraw,
  resolveSpellCastError,
  revalidateRoundSurfaces,
  type SpellCastActionState,
} from "@/app/rounds/roundActionHelpers";

function isRoundAlreadyStartedError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "23505";
}

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
  await broadcastRoomChanged(supabase, roomId);

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
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
}

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
  await broadcastRoomChanged(supabase, roomId);
  await advanceRound(supabase, roundId, "lateDeclared");

  revalidateRoundSurfaces();
}

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
  await broadcastRoomChanged(supabase, roomId);

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
  await broadcastRoomChanged(supabase, roomId);
  await advanceRound(supabase, roundId, "roundClosed");

  revalidateRoundSurfaces();
}

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
  await advanceRound(supabase, roundId, "layerRolled");

  revalidateRoundSurfaces();
}

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
  await advanceRound(supabase, roundId, "layerRolled");

  revalidateRoundSurfaces();
}

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
  await advanceRound(supabase, roundId, "pendingDieResolved");
  await broadcastRoomChanged(supabase, await getRoundRoomId(supabase, roundId));

  revalidateRoundSurfaces();
}

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
  await advanceRound(supabase, roundId, "pendingDieResolved");
  await broadcastRoomChanged(supabase, await getRoundRoomId(supabase, roundId));

  revalidateRoundSurfaces();
  return { status: "idle" };
}

export async function resolveCardSwapAction(formData: FormData) {
  const keepNew = formData.get("keepNew") === "true";
  const rawRoomId = formData.get("roomId");
  const roomId = typeof rawRoomId === "string" && rawRoomId ? rawRoomId : undefined;

  const supabase = await createClient();
  const closedRoundId = await resolveCardSwap(supabase, keepNew, roomId);

  if (closedRoundId) {
    await advanceRound(supabase, closedRoundId, "reactionWindowChanged");
    if (roomId) {
      await broadcastRoomChanged(supabase, roomId);
    }
  }

  revalidateRoundSurfaces();
}

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
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
  return { status: "idle" };
}

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
  await advanceRound(supabase, roundId, "deferredTargetSet");

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
  return { status: "idle" };
}

export async function setTeaPartyRevoltTargetAction(
  _prevState: SpellCastActionState,
  formData: FormData,
): Promise<SpellCastActionState> {
  const roundId = formData.get("roundId");
  const targetPlayerId = formData.get("targetPlayerId");

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("setTeaPartyRevoltTargetAction: missing roundId");
  }
  if (typeof targetPlayerId !== "string" || !targetPlayerId) {
    throw new Error("setTeaPartyRevoltTargetAction: missing targetPlayerId");
  }

  const supabase = await createClient();
  try {
    await setTeaPartyRevoltTarget(supabase, roundId, targetPlayerId);
  } catch (error) {
    return resolveSpellCastError(error);
  }
  await advanceRound(supabase, roundId, "revoltPickMade");

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
  return { status: "idle" };
}

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
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
  return { status: "idle" };
}

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

  await advanceRound(supabase, roundId, "reactionWindowChanged");

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
  return { status: "idle" };
}

export async function spendCourageTokenAction(
  _prevState: SpellCastActionState,
  formData: FormData,
): Promise<SpellCastActionState> {
  const roundId = formData.get("roundId");

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("spendCourageTokenAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await spendCourageToken(supabase, roundId);
  } catch (error) {
    return resolveSpellCastError(error);
  }

  await advanceRound(supabase, roundId, "reactionWindowChanged");

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
  return { status: "idle" };
}

export async function passReactionWindowAction(formData: FormData) {
  const roundId = formData.get("roundId");

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("passReactionWindowAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await passReactionWindow(supabase, roundId);
  } catch (error) {
    if (!isStaleRoundError(error)) throw error;
    revalidateRoundSurfaces();
    return;
  }

  await advanceRound(supabase, roundId, "reactionWindowChanged");

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
}

export async function voteSkipReactionWindowAction(formData: FormData) {
  const roundId = formData.get("roundId");

  if (typeof roundId !== "string" || !roundId) {
    throw new Error("voteSkipReactionWindowAction: missing roundId");
  }

  const supabase = await createClient();
  try {
    await voteSkipReactionWindow(supabase, roundId);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (!isStaleRoundError(error) && code !== "RFB51" && code !== "RFB52") throw error;
    revalidateRoundSurfaces();
    return;
  }

  await advanceRound(supabase, roundId, "reactionWindowChanged");

  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
}

export async function notifyOrderChangedAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("notifyOrderChangedAction: missing roundId");
  }

  const supabase = await createClient();
  const roomId = await getRoundRoomId(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
}

export async function confirmRoundReplayAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("confirmRoundReplayAction: missing roundId");
  }

  const supabase = await createClient();
  const roomId = await getRoundRoomId(supabase, roundId);
  await confirmRoundReplay(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
}

export async function declineRoundReplayAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("declineRoundReplayAction: missing roundId");
  }

  const supabase = await createClient();
  const roomId = await getRoundRoomId(supabase, roundId);
  await declineRoundReplay(supabase, roundId);
  await broadcastRoomChanged(supabase, roomId);

  revalidateRoundSurfaces();
}
