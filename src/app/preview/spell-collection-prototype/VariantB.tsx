"use client";

import { useState } from "react";
import { artFor, type CollectionCard, TOTAL_CATALOG_SIZE } from "./mockData";

/**
 * Variant B — "Binder pages by tier". Three tabs (Common/Rare/Epic), each
 * its own progress fraction. Tapping a card expands it inline (accordion,
 * pushes siblings) instead of a modal — the effect text reads as part of
 * the page, not an overlay. Structurally distinct from Variant A: no
 * cross-tier grid, no modal, per-tier completion instead of one aggregate.
 */

const TIER_ORDER: CollectionCard["tier"][] = ["common", "rare", "epic"];

const TIER_ACCENT: Record<CollectionCard["tier"], string> = {
  common: "text-parchment-dim",
  rare: "text-gilt-bright",
  epic: "text-ember-bright",
};

function TierRow({
  card,
  index,
  expanded,
  onToggle,
}: {
  card: CollectionCard;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const discovered = card.drawCount > 0;
  return (
    <div className="border-b border-gilt-dark/40 last:border-none">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 py-2 text-left hover:bg-tavern-panel-dark/60"
      >
        <div className="h-12 w-9 shrink-0 overflow-hidden rounded border-2 border-gilt-dark bg-tavern-plank-dark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={artFor(card.cardId, index)}
            alt=""
            className={`h-full w-full object-cover ${discovered ? "" : "grayscale brightness-[0.35]"}`}
          />
        </div>
        <span className={`flex-1 font-display text-sm uppercase tracking-wide ${discovered ? "text-parchment" : "text-parchment-dim"}`}>
          {card.name}
        </span>
        {discovered && card.drawCount > 1 ? (
          <span className="shrink-0 font-mono text-xs text-gilt-bright">×{card.drawCount}</span>
        ) : null}
        <span className="shrink-0 font-mono text-xs text-parchment-dim">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded ? (
        <div className="px-2 pb-3">
          {discovered ? (
            <>
              <p className="font-mono text-xs text-parchment-dim">
                {card.castingTime === "A" ? "Action" : "Reaction"} · {card.target}
              </p>
              <p className="mt-1 font-body text-sm text-parchment">{card.effectText}</p>
            </>
          ) : (
            <p className="font-body text-sm text-parchment-dim">Not yet drawn — effect hidden until discovered.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function VariantB({ cards }: { cards: CollectionCard[]; discoveredCount: number }) {
  const [activeTier, setActiveTier] = useState<CollectionCard["tier"]>("common");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const tierCards = cards.filter((c) => c.tier === activeTier);

  return (
    <div className="w-full max-w-md">
      <div className="mb-2 flex gap-1 rounded-lg border-4 border-gilt bg-tavern-panel p-1">
        {TIER_ORDER.map((tier) => {
          const inTier = cards.filter((c) => c.tier === tier);
          const discovered = inTier.filter((c) => c.drawCount > 0).length;
          return (
            <button
              key={tier}
              type="button"
              onClick={() => {
                setActiveTier(tier);
                setExpandedId(null);
              }}
              className={`flex-1 rounded-md px-2 py-2 text-center font-display text-[10px] uppercase tracking-widest transition-colors ${
                activeTier === tier
                  ? "bg-ember text-parchment"
                  : `text-parchment-dim hover:bg-tavern-plank hover:text-parchment ${TIER_ACCENT[tier]}`
              }`}
            >
              {tier}
              <div className="font-mono text-[10px] normal-case tracking-normal">
                {discovered}/{inTier.length}
              </div>
            </button>
          );
        })}
      </div>

      <p className="mb-2 px-1 font-mono text-[11px] text-parchment-dim">
        Sample shown of {TOTAL_CATALOG_SIZE}-card catalog
      </p>

      <div className="rounded-lg border-4 border-gilt bg-tavern-panel p-2">
        {tierCards.map((card) => {
          const index = cards.indexOf(card);
          return (
            <TierRow
              key={card.cardId}
              card={card}
              index={index}
              expanded={expandedId === card.cardId}
              onToggle={() => setExpandedId((prev) => (prev === card.cardId ? null : card.cardId))}
            />
          );
        })}
      </div>
    </div>
  );
}
