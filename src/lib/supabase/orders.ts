import type { SupabaseClient } from "@supabase/supabase-js";
import { apiClientFor, type ApiClient } from "@/lib/api/client";
import { isPortEnabled } from "@/lib/api/portFlags";

export type DrinkType = "tea" | "coffee";

export async function getMyOrderForRound(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<DrinkType | null> {
  if (await isPortEnabled(supabase, "getMyOrderForRound")) {
    return ((await api().getMyOrderForRound(roundId)).drinkType as DrinkType | null | undefined) ?? null;
  }
  const { data, error } = await supabase
    .from("orders")
    .select("drink_type")
    .eq("round_id", roundId)
    .eq("player_id", playerId)
    .maybeSingle();

  if (error) throw error;
  return (data?.drink_type as DrinkType | undefined) ?? null;
}

export async function getMyMostRecentOrder(
  supabase: SupabaseClient,
  playerId: string,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<DrinkType | null> {
  if (await isPortEnabled(supabase, "getMyMostRecentOrder")) {
    return ((await api().getMyMostRecentOrder()).drinkType as DrinkType | null | undefined) ?? null;
  }
  const { data, error } = await supabase
    .from("orders")
    .select("drink_type")
    .eq("player_id", playerId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data?.drink_type as DrinkType | undefined) ?? null;
}

export async function getMyOrderableRound(supabase: SupabaseClient, roomId: string): Promise<string | null> {
  const { data: roundRow, error: roundError } = await supabase
    .from("rounds")
    .select("id, resolved_at")
    .eq("room_id", roomId)
    .eq("status", "resolved")
    .order("resolved_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (roundError) throw roundError;
  if (!roundRow) return null;

  const { count: newerResolvedCount, error: windowError } = await supabase
    .from("rounds")
    .select("id", { count: "exact", head: true })
    .eq("room_id", roomId)
    .eq("status", "resolved")
    .gt("resolved_at", roundRow.resolved_at as string);

  if (windowError) throw windowError;
  if ((newerResolvedCount ?? 0) > 0) return null;

  return roundRow.id as string;
}

export async function submitOrder(
  supabase: SupabaseClient,
  roundId: string,
  drinkType: DrinkType,
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<void> {
  if (await isPortEnabled(supabase, "submitOrder")) {
    await api().submitOrder(roundId, drinkType);
    return;
  }
  const { error } = await supabase.rpc("submit_order", {
    p_round_id: roundId,
    p_drink_type: drinkType,
  });
  if (error) throw error;
}
