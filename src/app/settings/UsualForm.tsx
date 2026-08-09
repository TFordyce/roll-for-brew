"use client";

import { useActionState, useEffect, useState } from "react";
import { updateUsualDrinkAction, type UpdateUsualDrinkState } from "@/app/settings/actions";
import { MILK_OPTIONS, SUGAR_OPTIONS, type DrinkType, type UsualDrink } from "@/lib/supabase/usualDrinks";

const initialState: UpdateUsualDrinkState = { status: "idle" };

const selectClassName =
  "rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none";

/**
 * One drink type's Usual editor (tea or coffee, issue #225) — a milk
 * selector and a sugar selector saved together via updateUsualDrinkAction.
 * Rendered twice by UsualForm below, once per drink type, each with its own
 * save state so editing one Usual never disturbs the other's "Saved" flash.
 * An unset Usual (usual === null) starts both selects on their first
 * option rather than leaving them blank — a valid, no-preference state that
 * only becomes a saved row once the player actually hits Save. The status
 * line above the selects is what actually distinguishes "never saved" from
 * "saved as Dairy/None", since the selects themselves can't show blank.
 */
function UsualDrinkSection({ drinkType, usual }: { drinkType: DrinkType; usual: UsualDrink | null }) {
  const [state, formAction, isPending] = useActionState(updateUsualDrinkAction, initialState);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (state.status !== "saved" || state.drinkType !== drinkType) return;
    setShowSaved(true);
    const timer = setTimeout(() => setShowSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [state, drinkType]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="drinkType" value={drinkType} />

      <p className="font-body text-xs text-parchment-dim">
        {usual
          ? `Currently saved: ${usual.milk} milk, ${usual.sugar} sugar${usual.decaf ? ", decaf" : ""}.`
          : "No Usual saved yet — choosing and saving below sets one."}
      </p>

      <label className="flex flex-col gap-1 font-body text-sm text-parchment">
        Milk
        <select name="milk" defaultValue={usual?.milk ?? MILK_OPTIONS[0]} className={selectClassName}>
          {MILK_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 font-body text-sm text-parchment">
        Sugar
        <select name="sugar" defaultValue={usual?.sugar ?? SUGAR_OPTIONS[0]} className={selectClassName}>
          {SUGAR_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 font-body text-sm text-parchment">
        <input type="checkbox" name="decaf" defaultChecked={usual?.decaf ?? false} className="h-4 w-4" />
        Decaf
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {showSaved ? (
          <span role="status" className="font-display text-sm uppercase tracking-wide text-gilt-bright">
            Saved
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Settings' Tea Usual / Coffee Usual editors (issue #225) — two
 * independent UsualDrinkSections, one per drink type. The caller (Settings
 * page) supplies whichever Usuals are currently saved, `null` for either
 * that's never been set.
 */
export function UsualForm({
  usualDrinks,
}: {
  usualDrinks: Record<DrinkType, UsualDrink | null>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="mb-2 font-display text-xs uppercase tracking-widest text-parchment-dim">Tea</h3>
        <UsualDrinkSection drinkType="tea" usual={usualDrinks.tea} />
      </div>
      <div>
        <h3 className="mb-2 font-display text-xs uppercase tracking-widest text-parchment-dim">Coffee</h3>
        <UsualDrinkSection drinkType="coffee" usual={usualDrinks.coffee} />
      </div>
    </div>
  );
}
