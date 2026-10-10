"use client";

import { useEffect, useState } from "react";
import { firstNameOrFallback } from "@/lib/game/displayName";
import { type MenuEntry } from "@/lib/supabase/menu";

export type RoundMenuParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
};

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
