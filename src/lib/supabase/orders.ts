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
 * The most recently resolved round in a room whose Order Window (submit_order,
 * 0062) is still open — mirrors getMyRateableRound's (brewRatings.ts) "most
 * recent resolved round, unless a newer one has since resolved" shape, minus
 * the rating window's non-brewer-participant restriction: any player can
 * Order regardless of role.
 *
 * Needed because getActiveRound only ever returns 'open'/'closed' rounds —
 * the moment a round resolves it stops appearing there, even though the
 * Order Window itself stays open all the way through 'resolved' (ADR 0004).
 * Callers should use this only once getActiveRound has already come back
 * null, to pick up wherever the Order picker needs to keep working through
 * the rest of the window.
 */
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
