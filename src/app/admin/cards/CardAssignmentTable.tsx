"use client";

import { useMemo, useState } from "react";
import { CardAssignmentRow } from "./CardAssignmentRow";
import type { CardAssignment } from "@/lib/supabase/adminCards";
import type { RealPlayer } from "@/lib/supabase/players";

/**
 * The /admin/cards bulk table (issue #154) — one row per catalog card, with
 * a search bar filtering by name so a large backfill across most of the
 * player base can be done in one sitting rather than one card at a time.
 * Filtering is plain client-side state over the already-fetched card list
 * (71 rows — small enough that a server round-trip per keystroke would be
 * pure overhead).
 */
export function CardAssignmentTable({ cards, players }: { cards: CardAssignment[]; players: RealPlayer[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return cards;
    return cards.filter((card) => card.name.toLowerCase().includes(needle));
  }, [cards, search]);

  return (
    <div>
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search cards by name…"
        className="mb-3 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-3 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
      />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b-2 border-gilt-dark text-left font-display text-[10px] uppercase tracking-widest text-parchment-dim">
              <th className="py-1 pr-3">Card</th>
              <th className="py-1 pr-3">Holder</th>
              <th className="py-1">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((card) => (
              <CardAssignmentRow key={card.cardId} card={card} players={players} />
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-3 font-body text-sm text-parchment-dim">No cards match &ldquo;{search}&rdquo;.</p>
      ) : null}
    </div>
  );
}
