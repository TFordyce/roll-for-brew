import type { SupabaseClient } from "@supabase/supabase-js";

export type DrinkType = "tea" | "coffee";

export const DRINK_TYPES: DrinkType[] = ["tea", "coffee"];

export type Milk = "Dairy" | "Oat" | "Soy" | "None";

export const MILK_OPTIONS: Milk[] = ["Dairy", "Oat", "Soy", "None"];

export type Sugar = "None" | "Sprinkle" | "Half Tsp" | "1 Tsp" | "1.5 Tsp" | "2 Tsp" | "3 Tsp";

export const SUGAR_OPTIONS: Sugar[] = ["None", "Sprinkle", "Half Tsp", "1 Tsp", "1.5 Tsp", "2 Tsp", "3 Tsp"];

export type UsualDrink = { milk: Milk; sugar: Sugar };

/**
 * The caller's own Usual for both drink types (supabase/migrations/
 * 0062_usual_order_menu.sql, issue #224), keyed by drink_type. A drink type
 * with no saved row comes back as `null` -- leaving a Usual unset is a valid
 * state (issue #225), not an error.
 */
export async function getUsualDrinks(
  supabase: SupabaseClient,
  playerId: string,
): Promise<Record<DrinkType, UsualDrink | null>> {
  const { data, error } = await supabase
    .from("usual_drinks")
    .select("drink_type, milk, sugar")
    .eq("player_id", playerId);

  if (error) throw error;

  const result: Record<DrinkType, UsualDrink | null> = { tea: null, coffee: null };
  for (const row of data ?? []) {
    const drinkType = row.drink_type as DrinkType;
    result[drinkType] = { milk: row.milk as Milk, sugar: row.sugar as Sugar };
  }
  return result;
}

/**
 * Upserts the caller's Usual for one drink type. Direct table write (not an
 * RPC), matching setRollInputMode: usual_drinks' own-row RLS policies
 * (insertable/updatable by their own player) are the only guard needed, same
 * as player_settings.
 */
export async function setUsualDrink(
  supabase: SupabaseClient,
  playerId: string,
  drinkType: DrinkType,
  milk: Milk,
  sugar: Sugar,
): Promise<void> {
  const { error } = await supabase
    .from("usual_drinks")
    .upsert(
      { player_id: playerId, drink_type: drinkType, milk, sugar, updated_at: new Date().toISOString() },
      { onConflict: "player_id,drink_type" },
    );

  if (error) throw error;
}
