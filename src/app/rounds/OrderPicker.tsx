"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { submitOrder, type DrinkType } from "@/lib/supabase/orders";
import { notifyOrderChangedAction } from "@/app/rounds/actions";
import { CardFrame } from "@/app/_components/CardFrame";

/**
 * The round Order picker (issue #226, part of #223) — a tea/coffee toggle
 * decoupled from declare/withdraw (ADR 0004): available to any player once
 * a round is open, whether or not (or when) they've declared in, and stays
 * editable through the whole Order Window (submit_order, 0062, enforces the
 * window server-side; this picker doesn't try to duplicate that check
 * client-side beyond surfacing whatever error it raises).
 *
 * Talks to submit_order directly via the browser client, same immediate-tap
 * pattern as BrewRatingPanel's stars, rather than a server-action form —
 * there's no other server-rendered state this needs to force a refresh of...
 * except the live Menu (issue #227), which every other device's RoundMenu
 * needs to hear about. notifyOrderChangedAction fires the
 * broadcast-plus-revalidate that a form action would have gotten for free;
 * it's called best-effort, after the fact, since a failed notify shouldn't
 * roll back an Order that already saved successfully.
 */
export function OrderPicker({
  roundId,
  initialDrinkType,
}: {
  roundId: string;
  /**
   * The picker's starting selection — resolved server-side by the caller as
   * "this round's existing Order, else the player's most recent Order
   * across any room, else null" (issue #226's sticky-default acceptance
   * criterion). Null means neither button starts highlighted; the player
   * has never ordered anything, ever.
   */
  initialDrinkType: DrinkType | null;
}) {
  const [selected, setSelected] = useState<DrinkType | null>(initialDrinkType);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once submit_order rejects with RFB29/RFB30 (round gone or the Order
  // Window has closed, 0062) — both are permanent for this picker instance,
  // not a network blip, so further taps are disabled rather than inviting a
  // "try again" that would just fail the same way every time.
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
        // Best-effort — the Order itself already saved; other devices just
        // pick the change up on their next unrelated refresh instead.
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
