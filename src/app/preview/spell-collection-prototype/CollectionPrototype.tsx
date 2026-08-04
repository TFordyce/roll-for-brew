"use client";

import { useSearchParams } from "next/navigation";
import { PrototypeSwitcher } from "./PrototypeSwitcher";
import { PrototypeNav, StatsTeaser, RosterTapDemo } from "./EntryPoints";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";
import { MOCK_COLLECTION, MOCK_DISCOVERED_COUNT } from "./mockData";

/**
 * PROTOTYPE — ticket #124 (Spell Collection page: visual design &
 * entry-point prototype), wayfinder map #120.
 *
 * Three radically different takes on the collection grid, switchable via
 * `?variant=`:
 *   A — Card grid + modal inspector (closest to the existing held-card
 *       widget's MTG/Yu-Gi-Oh language)
 *   B — Tabbed binder pages by tier, inline-expand instead of a modal
 *   C — Spotlight/display-case carousel with a circular completion gauge
 *
 * `?player=` (self | alex | sam) demonstrates the entry-point routing
 * decision: real implementation is /collection (self) vs
 * /collection/:playerId (others) — this route stands in for both.
 */
const VARIANTS = [
  { key: "A", label: "Grid + modal" },
  { key: "B", label: "Binder tabs" },
  { key: "C", label: "Spotlight carousel" },
];

export function CollectionPrototype() {
  const searchParams = useSearchParams();
  const variant = searchParams.get("variant") ?? "A";
  const activePlayerId = searchParams.get("player") ?? "self";

  // Same mock collection stands in for every player in this prototype —
  // the real page always renders off the RPC's return shape regardless of
  // whose id was passed in.
  const cards = MOCK_COLLECTION;
  const discoveredCount = MOCK_DISCOVERED_COUNT;

  return (
    <main className="relative flex min-h-screen flex-col items-center gap-4 bg-tavern-plank p-4 pb-24 sm:p-8">
      <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest text-tavern-panel">
        Prototype — local only, ticket #124
      </div>

      <PrototypeNav activePlayerId={activePlayerId} />

      <div className="w-full max-w-2xl">
        <StatsTeaser discovered={discoveredCount} total={71} onOpen={() => {}} />
      </div>

      <div className="w-full max-w-2xl">
        <RosterTapDemo activePlayerId={activePlayerId} />
      </div>

      <h1 className="mt-2 font-display text-lg font-semibold uppercase tracking-widest text-gilt-bright">
        {activePlayerId === "self" ? "Your Collection" : `${activePlayerId}'s Collection`}
      </h1>

      {variant === "A" ? <VariantA cards={cards} discoveredCount={discoveredCount} /> : null}
      {variant === "B" ? <VariantB cards={cards} discoveredCount={discoveredCount} /> : null}
      {variant === "C" ? <VariantC cards={cards} discoveredCount={discoveredCount} /> : null}

      <PrototypeSwitcher variants={VARIANTS} current={variant} />
    </main>
  );
}
