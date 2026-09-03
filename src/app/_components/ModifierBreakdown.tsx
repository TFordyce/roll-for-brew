"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatModifier } from "@/lib/game/rollCalculation";
import { getModifierBreakdown, type ModifierBreakdown as Breakdown } from "@/lib/supabase/modifierAdjustments";

/**
 * Wraps a player's modifier number in a tap/click target that opens a small
 * popover breaking it down into its three sources — cups made as brewer,
 * logged modifier_adjustments, and the rest-of-day spell modifier delta
 * (persistent_modifier_transfer / persistent_modifier_spend, issue #311) —
 * all room-scoped (issue #184, get_modifier_breakdown 0054 / 0085). The three
 * reconcile to room_players.modifier. Deliberately click-driven rather than
 * hover-driven so
 * the same interaction works identically on mobile and desktop (no
 * hover-only affordance) — used from both PlayerTile (Room roster) and
 * RoundReveal (round results).
 *
 * Fetches lazily on first open rather than eagerly for every roster tile —
 * most tiles are never tapped, so this avoids one RPC per rendered player.
 * PlayerTile's own /:playerId/collection link is scoped to just the avatar,
 * not this trigger, so there's no competing tap target to guard against
 * here.
 */
export function ModifierBreakdown({
  playerId,
  roomId,
  modifier,
  className = "font-mono text-xs text-parchment-dim",
}: {
  playerId: string;
  roomId: string;
  modifier: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
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

  function toggle() {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      if (next && breakdown === null && !loading) {
        setLoading(true);
        setLoadError(false);
        const supabase = createClient();
        getModifierBreakdown(supabase, playerId, roomId)
          .then(setBreakdown)
          .catch(() => setLoadError(true))
          .finally(() => setLoading(false));
      }
      return next;
    });
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={`Modifier breakdown: ${formatModifier(modifier)}`}
        className={`${className} underline decoration-dotted underline-offset-2`}
      >
        {formatModifier(modifier)}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Modifier breakdown"
          className="absolute left-1/2 top-full z-40 mt-1 w-40 -translate-x-1/2 rounded-md border-2 border-gilt-dark bg-tavern-panel p-2 text-left shadow-lg"
        >
          {loading ? (
            <p className="font-body text-xs text-parchment-dim">Loading&hellip;</p>
          ) : loadError ? (
            <p className="font-body text-xs text-parchment-dim">Couldn&apos;t load breakdown.</p>
          ) : breakdown ? (
            <dl className="space-y-1 font-mono text-xs text-parchment">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-parchment-dim">Cups made:</dt>
                <dd>{formatModifier(breakdown.cupsMade)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-parchment-dim">Adjustments:</dt>
                <dd>{formatModifier(breakdown.adjustments)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-parchment-dim">Spell effects:</dt>
                <dd>{formatModifier(breakdown.spellEffects)}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
