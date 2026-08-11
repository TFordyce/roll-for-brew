"use client";

import { useEffect, useState } from "react";
import { firstNameOrFallback } from "@/lib/game/displayName";
import { type MenuEntry } from "@/lib/supabase/menu";

export type RoundMenuParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
};

/**
 * The live Menu (issue #227, part of #223): who wants what this round, with
 * milk/sugar pulled from each orderer's current Usual. Entries and
 * participant names both arrive as props, already resolved by the caller
 * (page.tsx/admin/test-room's page.tsx) via getRoundMenu + getRoundParticipants,
 * the same "server component owns the data, MenuLive.tsx just triggers a
 * refetch" split RoundOpenLive/SpellCastLive already use elsewhere on this
 * page.
 *
 * Renders as a right-edge pop-out tab (issue #265) — the same hanging-tag +
 * pushpin-notepad pattern as BrewRatingPanel
 * (src/app/_components/BrewRatingPanel.tsx), stacked below its "Rate Brew"
 * tab. This is a presentation change only: the prop shape is unchanged from
 * the previous plain `CardFrame "Menu"` block, so callers don't fetch or
 * pass data any differently.
 *
 * Only ever contains this round's declared participants who have an Order
 * (round_menu's own round_participants join, 0062) — a participant with no
 * Order simply isn't in `entries`, no explicit "no drink" row (user story
 * 18). Renders nothing (not even the tab) when there's nobody to list yet,
 * so an empty Menu doesn't sit on the page before the first Order comes in —
 * same as the old `entries.length === 0 → return null`.
 *
 * A decaf preference (0063, issue #237) renders as a "Decaf " prefix on the
 * drink type ("Decaf Tea — Dairy, 1 Tsp") rather than a suffix — decided via
 * a standalone HTML prototype, issue #238. `entry.decaf` is always false
 * when `noPreferenceSet`, so the prefix only ever shows alongside a real
 * milk/sugar preference.
 */
export function RoundMenu({
  entries,
  participants,
}: {
  entries: MenuEntry[];
  participants: RoundMenuParticipant[];
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (entries.length === 0) return null;

  const participantById = new Map(participants.map((p) => [p.playerId, p]));

  function closePanel() {
    setOpen(false);
  }

  // Clicking the panel's background — anything that isn't a button — closes
  // it, same as the ×, mirroring BrewRatingPanel's handleBackgroundClick.
  function handleBackgroundClick(event: React.MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    if (open) closePanel();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-label={open ? "Close Menu" : "Open Menu"}
        aria-expanded={open}
        className={`fixed right-0 top-[210px] z-[55] flex flex-col items-center gap-1 rounded border-2 border-gilt bg-parchment px-2.5 py-2.5 font-display text-[10px] uppercase leading-tight tracking-wider text-tavern-panel shadow-lg transition-transform duration-300 ease-out ${
          open ? "translate-x-[140%] rotate-[4deg]" : "translate-x-0 rotate-[4deg] hover:-translate-x-1"
        }`}
      >
        {/* "Menu" is a single word, so unlike "Rate\nBrew" it can't literally
            span two lines — kept single-line rather than forcing an
            arbitrary break, same font/case treatment as Rate Brew's label. */}
        <span>Menu</span>
      </button>

      <div
        role="dialog"
        aria-label="Menu"
        aria-hidden={!open}
        onClick={handleBackgroundClick}
        className={`fixed right-4 top-[210px] z-50 w-64 rounded border-2 border-gilt-dark bg-parchment text-tavern-panel shadow-2xl transition-all duration-300 ease-out ${
          open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-[140%] opacity-0"
        }`}
      >
        <div className="relative p-4">
          <span
            className="absolute -top-3 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border border-ember bg-ember-bright"
            aria-hidden="true"
          />
          <div className="mb-3 flex items-center justify-between">
            <strong className="font-display text-xs uppercase tracking-widest">Menu</strong>
            <button type="button" onClick={closePanel} aria-label="Close" className="text-base leading-none">
              ×
            </button>
          </div>

          <ul className="divide-y divide-gilt-dark/40">
            {entries.map((entry) => {
              const participant = participantById.get(entry.playerId);
              const name = firstNameOrFallback(
                participant?.displayName ?? null,
                participant?.email ?? entry.playerId,
              );
              return (
                <li key={entry.playerId} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-body text-sm text-tavern-panel">{name}</span>
                  <span className="font-body text-xs text-tavern-panel/70">
                    {entry.decaf ? "Decaf " : ""}
                    {entry.drinkType === "tea" ? "Tea" : "Coffee"}
                    {entry.noPreferenceSet ? (
                      <span className="ml-1.5 text-gilt-dark">— no preference set</span>
                    ) : (
                      <span className="ml-1.5">
                        — {entry.milk}, {entry.sugar}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </>
  );
}
