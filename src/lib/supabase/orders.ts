import type { SupabaseClient } from "@supabase/supabase-js";

export type DrinkType = "tea" | "coffee";

/**
 * The caller's own Order for a specific round, or null if they haven't
 * placed one yet (orders' RLS is world-readable — see 0062's comment — so
 * this can be read directly rather than through an RPC). Feeds OrderPicker's
 * initial selection: a round already has priority over the sticky
 * most-recent-across-rooms default (getMyMostRecentOrder) once one exists.
 */
export async function getMyOrderForRound(
  supabase: SupabaseClient,
  roundId: string,
  playerId: string,
): Promise<DrinkType | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("drink_type")
    .eq("round_id", roundId)
    .eq("player_id", playerId)
    .maybeSingle();

  if (error) throw error;
  return (data?.drink_type as DrinkType | undefined) ?? null;
}

/**
 * The player's most recent Order across *any* room (issue #223 user story
 * 7 / issue #226's acceptance criteria) — computed as a plain query against
 * their most-recently-updated `orders` row, not a stored pointer, so it
 * always reflects whatever they actually picked last, in any room. Used only
 * as OrderPicker's fallback default when the current round has no Order of
 * its own yet.
 */
export async function getMyMostRecentOrder(
  supabase: SupabaseClient,
  playerId: string,
): Promise<DrinkType | null> {
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

/**
 * Submits or changes (upsert-on-repick) the caller's own Order for a round
 * (submit_order, 0062) — gated server-side by the Order Window (open from
 * the round reaching 'open' through 'resolved', ADR 0004).
 */
export async function submitOrder(
  supabase: SupabaseClient,
  roundId: string,
  drinkType: DrinkType,
): Promise<void> {
  const { error } = await supabase.rpc("submit_order", {
    p_round_id: roundId,
    p_drink_type: drinkType,
  });
  if (error) throw error;
}
