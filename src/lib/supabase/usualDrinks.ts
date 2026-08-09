import type { SupabaseClient } from "@supabase/supabase-js";

export type DrinkType = "tea" | "coffee";

export const DRINK_TYPES: DrinkType[] = ["tea", "coffee"];

export type Milk = "Dairy" | "Oat" | "Soy" | "None";

export const MILK_OPTIONS: Milk[] = ["Dairy", "Oat", "Soy", "None"];

export type Sugar = "None" | "Sprinkle" | "Half Tsp" | "1 Tsp" | "1.5 Tsp" | "2 Tsp" | "3 Tsp";

export const SUGAR_OPTIONS: Sugar[] = ["None", "Sprinkle", "Half Tsp", "1 Tsp", "1.5 Tsp", "2 Tsp", "3 Tsp"];

export type UsualDrink = { milk: Milk; sugar: Sugar; decaf: boolean };

/**
 * A given player's Usual for both drink types (supabase/migrations/
 * 0062_usual_order_menu.sql, issue #224), keyed by drink_type. `playerId` is
 * caller-supplied, not RLS-restricted to the caller's own row -- unlike
 * player_settings, usual_drinks' SELECT policy is world-readable (round_menu
 * needs to join any participant's Usual), so this can read anyone's row; the
 * Settings page (issue #225) just happens to always call it with the
 * current player's own id. A drink type with no saved row comes back as
 * `null` -- leaving a Usual unset is a valid state, not an error.
 *
 * `decaf` (0063_usual_drinks_decaf.sql, issue #237) is a hard requirement on
 * the Usual, tracked independently per drink type -- there's no separate
 * "decaf" row or global flag.
 */
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
