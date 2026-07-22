"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { closeRound, declareIn, startRound } from "@/lib/supabase/rounds";

export async function startRoundAction() {
  const supabase = await createClient();
  await startRound(supabase);
  revalidatePath("/");
}

export async function declareInAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("declareInAction: missing roundId");
  }

  const supabase = await createClient();
  await declareIn(supabase, roundId);
  revalidatePath("/");
}

export async function closeRoundAction(formData: FormData) {
  const roundId = formData.get("roundId");
  if (typeof roundId !== "string" || !roundId) {
    throw new Error("closeRoundAction: missing roundId");
  }

  const supabase = await createClient();
  await closeRound(supabase, roundId);
  revalidatePath("/");
}
