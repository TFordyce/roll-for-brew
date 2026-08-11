"use client";

import { useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { submitOrder, type DrinkType } from "@/lib/supabase/orders";
import { notifyOrderChangedAction } from "@/app/rounds/actions";

/**
 * Tea/Coffee order buttons flanking a player's own avatar (issue #267) —
 * replaces the standalone "Your Order" card (formerly OrderPicker.tsx) with
 * a picker docked directly to the avatar that already represents you in the
 * roster, rather than a second card the player has to find below it. Same
 * submit_order plumbing, best-effort notifyOrderChangedAction, and RFB29/
 * RFB30 (round gone / Order Window closed) handling as the old OrderPicker
 * — only the presentation changed. Still fully decoupled from declare/
 * withdraw (ADR 0004): available whenever `roundId`'s Order Window is open,
 * independent of round status. Callers should key this on `roundId` so a
 * new round's fresh `initialDrinkType` replaces stale selection state
 * rather than the two fighting each other.
 */
export function AvatarOrderPicker({
  roundId,
  initialDrinkType,
  children,
}: {
  roundId: string;
  initialDrinkType: DrinkType | null;
  /** The avatar (or avatar-wrapped-in-profile-link) this picker flanks. */
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<DrinkType | null>(initialDrinkType);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once submit_order rejects with RFB29/RFB30 — see OrderPicker's own
  // comment on why this disables further taps rather than inviting a retry.
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
        setError("Order window closed");
      } else {
        setError("Couldn't save order");
      }
    } finally {
      setPending(false);
    }
  }

  const pillClass = (active: boolean) =>
    `flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 font-display text-[11px] font-semibold uppercase tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
      active
        ? "border-gilt-bright bg-ember text-parchment"
        : "border-gilt-dark bg-transparent text-parchment-dim hover:border-gilt hover:text-parchment"
    }`;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => pick("tea")}
          disabled={pending || windowClosed}
          aria-pressed={selected === "tea"}
          aria-label="Order tea"
          title="Tea"
          className={pillClass(selected === "tea")}
        >
          T
        </button>
        {children}
        <button
          type="button"
          onClick={() => pick("coffee")}
          disabled={pending || windowClosed}
          aria-pressed={selected === "coffee"}
          aria-label="Order coffee"
          title="Coffee"
          className={pillClass(selected === "coffee")}
        >
          C
        </button>
      </div>
      {error ? <p className="text-[10px] text-ember-bright">{error}</p> : null}
    </div>
  );
}
