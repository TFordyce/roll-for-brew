import type { DrinkType } from "@/lib/supabase/orders";

export type MenuEntry = {
  playerId: string;
  drinkType: DrinkType;
  milk: string | null;
  sugar: string | null;
  decaf: boolean;
  noPreferenceSet: boolean;
};
