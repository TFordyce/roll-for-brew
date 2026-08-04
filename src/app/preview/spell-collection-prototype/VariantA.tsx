"use client";

import { useState } from "react";
import { artFor, type CollectionCard, TOTAL_CATALOG_SIZE } from "./mockData";
import { CompletionGauge } from "./CompletionGauge";

/**
 * Variant A — "Card grid + modal inspector". Dense TCG-style grid (closest
 * to SpellCardPanel/CardFrame's existing gold-frame language), tier read
 * off border colour + a corner badge, tap opens a full-screen modal for
 * the effect text. Filter tabs let you jump straight to a tier.
 */

const TIER_BORDER: Record<CollectionCard["tier"], string> = {
  common: "border-gilt-dark",
  rare: "border-gilt",
  epic: "border-ember-bright shadow-[0_0_16px_rgb(179_84_63_/_0.55)]",
};

const TIER_LABEL: Record<CollectionCard["tier"], string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
};

const TIER_ORDER: CollectionCard["tier"][] = ["common", "rare", "epic"];

const TIER_ACCENT: Record<CollectionCard["tier"], string> = {
  common: "text-parchment-dim",
  rare: "text-gilt-bright",
  epic: "text-ember-bright",
};

function CardTile({
  card,
  index,
  onTap,
}: {
  card: CollectionCard;
  index: number;
  onTap: () => void;
}) {
  const discovered = card.drawCount > 0;
  return (
    <button
      type="button"
      onClick={onTap}
      className={`group relative flex flex-col overflow-hidden rounded-md border-[3px] bg-tavern-panel-dark text-left ${TIER_BORDER[card.tier]}`}
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-tavern-plank-dark">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={artFor(card.cardId, index)}
          alt=""
          className={`h-full w-full object-cover ${discovered ? "" : "grayscale brightness-[0.3] contrast-125"}`}
        />
        {discovered && card.drawCount > 1 ? (
          <span className="absolute right-1 top-1 rounded-full bg-ember px-1.5 py-0.5 font-mono text-[10px] text-parchment shadow-[0_0_0_1px_theme(colors.gilt.dark)]">
            ×{card.drawCount}
          </span>
        ) : null}
        <span className="absolute left-1 top-1 rounded bg-black/60 px-1 py-0.5 font-display text-[9px] uppercase tracking-widest text-gilt-bright">
          {TIER_LABEL[card.tier]}
        </span>
      </div>
      <p
        className={`truncate px-1.5 py-1.5 font-display text-xs uppercase tracking-wide ${
          discovered ? "text-parchment" : "text-parchment-dim"
        }`}
      >
        {card.name}
      </p>
    </button>
  );
}

export function VariantA({ cards, discoveredCount }: { cards: CollectionCard[]; discoveredCount: number }) {
  const [tierFilter, setTierFilter] = useState<CollectionCard["tier"]>("common");
  const [inspecting, setInspecting] = useState<CollectionCard | null>(null);

  const visible = cards.filter((c) => c.tier === tierFilter);
  const inspectingIndex = inspecting ? cards.indexOf(inspecting) : -1;

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-3 flex items-center justify-center">
        <CompletionGauge discovered={discoveredCount} total={TOTAL_CATALOG_SIZE} />
      </div>

      <div className="mb-3 flex gap-1 rounded-lg border-4 border-gilt bg-tavern-panel p-1">
        {TIER_ORDER.map((tier) => {
          const inTier = cards.filter((c) => c.tier === tier);
          const tierDiscovered = inTier.filter((c) => c.drawCount > 0).length;
          return (
            <button
              key={tier}
              type="button"
              onClick={() => setTierFilter(tier)}
              className={`flex-1 rounded-md px-2 py-2 text-center font-display text-[10px] uppercase tracking-widest transition-colors ${
                tierFilter === tier
                  ? "bg-ember text-parchment"
                  : `text-parchment-dim hover:bg-tavern-plank hover:text-parchment ${TIER_ACCENT[tier]}`
              }`}
            >
              {tier}
              <div className="font-mono text-[10px] normal-case tracking-normal">
                {tierDiscovered}/{inTier.length}
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {visible.map((card) => {
          const index = cards.indexOf(card);
          return <CardTile key={card.cardId} card={card} index={index} onTap={() => setInspecting(card)} />;
        })}
      </div>

      {inspecting ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setInspecting(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-xs rounded-lg border-4 bg-tavern-panel p-4 shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.6)] ${TIER_BORDER[inspecting.tier]}`}
          >
            <div className="mb-3 aspect-[3/4] w-full overflow-hidden rounded-md bg-tavern-plank-dark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={artFor(inspecting.cardId, inspectingIndex)}
                alt=""
                className={`h-full w-full object-cover ${inspecting.drawCount > 0 ? "" : "grayscale brightness-[0.3] contrast-125"}`}
              />
            </div>
            <p className="font-display text-sm font-semibold uppercase tracking-wide text-gilt-bright">
              {inspecting.name}
            </p>
            {inspecting.drawCount > 0 ? (
              <>
                <p className="mt-0.5 font-mono text-xs text-parchment-dim">
                  {TIER_LABEL[inspecting.tier]} · {inspecting.castingTime === "A" ? "Action" : "Reaction"} ·{" "}
                  {inspecting.target} · drawn ×{inspecting.drawCount}
                </p>
                <p className="mt-2 font-body text-sm text-parchment">{inspecting.effectText}</p>
              </>
            ) : (
              <p className="mt-1 font-body text-sm text-parchment-dim">{TIER_LABEL[inspecting.tier]} · not yet drawn.</p>
            )}
            <button
              type="button"
              onClick={() => setInspecting(null)}
              className="mt-3 w-full rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
