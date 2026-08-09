import type { SupabaseClient } from "@supabase/supabase-js";
import type { DrinkType } from "@/lib/supabase/orders";

export type MenuEntry = {
  playerId: string;
  drinkType: DrinkType;
  milk: string | null;
  sugar: string | null;
  /** True when the player has no `usual_drinks` row for `drinkType` — the
   * Menu still shows their Order, just with no milk/sugar to go with it
   * (issue #223 user story 14). */
  noPreferenceSet: boolean;
};

/**
 * Reads a round's Menu (issue #227) — the `round_menu` view (0062), a live
 * join of `round_participants` × `orders` × `usual_drinks` restricted to
 * this round. A participant who never placed an Order for this round simply
 * isn't in the result (the view inner-joins `orders`); nothing here
 * distinguishes "declared but ordered nothing" from "never declared" —
 * that's `getRoundParticipants`' job, not this one's.
 *
 * Always a live read of each orderer's *current* Usual (ADR 0003) — no
 * snapshot, no caching. Callers needing display names join this against
 * `getRoundParticipants`'s own result by playerId, same as RoundReveal does
 * for modifiers.
 */
export async function getRoundMenu(supabase: SupabaseClient, roundId: string): Promise<MenuEntry[]> {
  const { data, error } = await supabase
    .from("round_menu")
    .select("player_id, drink_type, milk, sugar, no_preference_set")
    .eq("round_id", roundId);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    playerId: row.player_id as string,
    drinkType: row.drink_type as DrinkType,
    milk: row.milk as string | null,
    sugar: row.sugar as string | null,
    noPreferenceSet: row.no_preference_set as boolean,
  }));
}
