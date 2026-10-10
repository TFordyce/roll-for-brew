import type { SupabaseClient } from "@supabase/supabase-js";

export type DrinkType = "tea" | "coffee";

export const DRINK_TYPES: DrinkType[] = ["tea", "coffee"];

export type Milk = "Dairy" | "Oat" | "Soy" | "None";

export const MILK_OPTIONS: Milk[] = ["Dairy", "Oat", "Soy", "None"];

export type Sugar = "None" | "Sprinkle" | "Half Tsp" | "1 Tsp" | "1.5 Tsp" | "2 Tsp" | "3 Tsp";

export const SUGAR_OPTIONS: Sugar[] = ["None", "Sprinkle", "Half Tsp", "1 Tsp", "1.5 Tsp", "2 Tsp", "3 Tsp"];

export type UsualDrink = { milk: Milk; sugar: Sugar; decaf: boolean };

export async function getUsualDrinks(
  supabase: SupabaseClient,
  playerId: string,
): Promise<Record<DrinkType, UsualDrink | null>> {
  const { data, error } = await supabase
    .from("usual_drinks")
    .select("drink_type, milk, sugar, decaf")
    .eq("player_id", playerId);

  if (error) throw error;

  const result: Record<DrinkType, UsualDrink | null> = { tea: null, coffee: null };
  for (const row of data ?? []) {
    const drinkType = row.drink_type as DrinkType;
    result[drinkType] = { milk: row.milk as Milk, sugar: row.sugar as Sugar, decaf: row.decaf as boolean };
  }
  return result;
}

export async function setUsualDrink(
  supabase: SupabaseClient,
  playerId: string,
  drinkType: DrinkType,
  milk: Milk,
  sugar: Sugar,
  decaf: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("usual_drinks")
    .upsert(
      { player_id: playerId, drink_type: drinkType, milk, sugar, decaf, updated_at: new Date().toISOString() },
      { onConflict: "player_id,drink_type" },
    );

  if (error) throw error;
}
