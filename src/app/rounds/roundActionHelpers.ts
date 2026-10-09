import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { drawSpellCardAs, recordPendingSpellDraw } from "@/lib/supabase/spellCards";

export function revalidateRoundSurfaces() {
  revalidatePath("/");
  revalidatePath("/admin/test-room");
}

export async function maybeRecordPendingSpellDraw(
  supabase: Awaited<ReturnType<typeof createClient>>,
  value: number,
  roundId: string,
) {
  if (value === 1) await recordPendingSpellDraw(supabase, roundId, "nat1");
  else if (value === 20) await recordPendingSpellDraw(supabase, roundId, "nat20");
}

export async function maybeDrawSpellCardAs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  value: number,
  roomId: string,
  roundId: string,
  playerId: string,
  forcedCardId?: string,
) {
  if (value === 1) await drawSpellCardAs(supabase, "nat1", roomId, roundId, playerId, forcedCardId);
  else if (value === 20) await drawSpellCardAs(supabase, "nat20", roomId, roundId, playerId, forcedCardId);
}

export function isStaleRoundError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "RFB01" ||
    code === "RFB02" ||
    code === "RFB03" ||
    code === "RFB04" ||
    code === "RFB05" ||
    code === "RFB31" ||
    code === "RFB32"
  );
}

export type SpellCastActionState = { status: "idle" } | { status: "error"; message: string };

export function spellCastActionError(error: unknown): { status: "error"; message: string } {
  const message = (error as { message?: string } | null)?.message;
  return {
    status: "error",
    message: message ? message.replace(/^[a-z_]+: /, "") : "Something went wrong casting that card — try again.",
  };
}

export function resolveSpellCastError(error: unknown): SpellCastActionState {
  if (isStaleRoundError(error)) {
    revalidateRoundSurfaces();
    return { status: "idle" };
  }
  return spellCastActionError(error);
}
