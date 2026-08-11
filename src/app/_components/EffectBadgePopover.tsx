"use client";

import { useEffect, useRef, useState } from "react";
import type { ActiveEffectBadge } from "@/lib/supabase/spellCasts";

/**
 * A single active-effect dot (issue #69) wrapped in a tap/click target that
 * opens a small popover with that effect's card name, tier, and rounds
 * remaining (issue #249). Deliberately click-driven rather than hover-driven,
 * mirroring `ModifierBreakdown` (issue #184), so the interaction is identical
 * on mobile and desktop. With multiple stacked effects on one player,
 * `PlayerTile` renders one of these per dot — each is its own independent
 * tap target showing only its own effect's detail, never a combined list.
 * All effect data is already in hand via `get_room_active_effects`, so
 * there's no fetch here (unlike `ModifierBreakdown`, which lazy-loads).
 */
export function EffectBadgePopover({ effect }: { effect: ActiveEffectBadge }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-label={`Active effect: ${effect.cardName}`}
        className={`h-2.5 w-2.5 rounded-full ${
          effect.polarity === "negative" ? "bg-red-600" : "bg-gilt-bright"
        }`}
      />
      {open ? (
        <div
          role="dialog"
          aria-label="Active effect"
          className="absolute left-1/2 top-full z-40 mt-1 w-40 -translate-x-1/2 rounded-md border-2 border-gilt-dark bg-tavern-panel p-2 text-left shadow-lg"
        >
          <dl className="space-y-1 font-mono text-xs text-parchment">
            <div>
              <dt className="text-parchment-dim">Card:</dt>
              <dd>{effect.cardName}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-parchment-dim">Tier:</dt>
              <dd className="capitalize">{effect.tier}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-parchment-dim">Rounds left:</dt>
              <dd>{effect.roundsRemaining}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
