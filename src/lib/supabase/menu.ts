import type { SupabaseClient } from "@supabase/supabase-js";
import type { DrinkType } from "@/lib/supabase/orders";

export type MenuEntry = {
  playerId: string;
  drinkType: DrinkType;
  milk: string | null;
  sugar: string | null;
  decaf: boolean;
  noPreferenceSet: boolean;
};

export async function getRoundMenu(supabase: SupabaseClient, roundId: string): Promise<MenuEntry[]> {
  const { data, error } = await supabase
    .from("round_menu")
    .select("player_id, drink_type, milk, sugar, decaf, no_preference_set")
    .eq("round_id", roundId);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    playerId: row.player_id as string,
    drinkType: row.drink_type as DrinkType,
    milk: row.milk as string | null,
    sugar: row.sugar as string | null,
    decaf: row.decaf as boolean,
    noPreferenceSet: row.no_preference_set as boolean,
  }));
}
