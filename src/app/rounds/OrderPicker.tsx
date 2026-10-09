"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { submitOrder, type DrinkType } from "@/lib/supabase/orders";
import { notifyOrderChangedAction } from "@/app/rounds/actions";
import { CardFrame } from "@/app/_components/CardFrame";

export function OrderPicker({
  roundId,
  initialDrinkType,
}: {
  roundId: string;
  initialDrinkType: DrinkType | null;
}) {
  const [selected, setSelected] = useState<DrinkType | null>(initialDrinkType);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowClosed, setWindowClosed] = useState(false);

  async function pick(drinkType: DrinkType) {
    if (pending || windowClosed || drinkType === selected) return;
    setPending(true);
    setError(null);
    const previous = selected;
    setSelected(drinkType);
    try {
      const supabase = createClient();
      await submitOrder(supabase, roundId, drinkType);
      try {
        const fd = new FormData();
        fd.set("roundId", roundId);
        await notifyOrderChangedAction(fd);
      } catch {
      }
    } catch (err) {
      setSelected(previous);
      const code = (err as { code?: string } | null)?.code;
      if (code === "RFB29" || code === "RFB30") {
        setWindowClosed(true);
        setError("The Order window for this round has closed.");
      } else {
        setError("Couldn't save your Order — try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <CardFrame title="Your Order" className="mt-4">
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => pick("tea")}
          disabled={pending || windowClosed}
          aria-pressed={selected === "tea"}
          className={`rounded-md border-2 px-4 py-2 font-display text-sm uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-60 ${
            selected === "tea"
              ? "border-gilt-bright bg-ember text-parchment"
              : "border-gilt-dark bg-transparent text-parchment-dim hover:border-gilt hover:text-parchment"
          }`}
        >
          Tea
        </button>
        <button
          type="button"
          onClick={() => pick("coffee")}
          disabled={pending || windowClosed}
          aria-pressed={selected === "coffee"}
          className={`rounded-md border-2 px-4 py-2 font-display text-sm uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-60 ${
            selected === "coffee"
              ? "border-gilt-bright bg-ember text-parchment"
              : "border-gilt-dark bg-transparent text-parchment-dim hover:border-gilt hover:text-parchment"
          }`}
        >
          Coffee
        </button>
      </div>

      {error ? <p className="mt-2 text-[11px] text-ember-bright">{error}</p> : null}
    </CardFrame>
  );
}
