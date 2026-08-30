"use client";

import { useState } from "react";
import type { SpellCollectionCard as SpellCollectionCardData } from "@/lib/supabase/spellCards";
import { cardTileView, groupByTier, isDiscovered, TIER_LABEL, TIER_ORDER, tierFractions, type Tier } from "@/lib/spellCollection";
import { SpellCollectionCard } from "@/app/_components/SpellCollectionCard";
import { CardInspectModal } from "@/app/_components/CardInspectModal";
import { SpellCardRatingRow } from "@/app/_components/SpellCardRatingRow";

/**
 * The dense Balatro-joker-style card grid + tap-to-inspect modal (issue
 * #134, part of the Spell Collection page spec #130) — the reviewed
 * prototype's Variant A layout (branch worktree-spell-collection-prototype,
 * commit 99bec1f) rebuilt on the real `get_player_spell_collection` data and
 * the shared `CardFrame`/gold-border visual language instead of prototype-
 * only chrome.
 */
export function SpellCollectionGrid({
  cards,
  ownCollection,
}: {
  cards: SpellCollectionCardData[];
  /** True only on the viewer's own collection — gates the spell-card rating row (issue #300). */
  ownCollection: boolean;
}) {
  const [tierFilter, setTierFilter] = useState<Tier>("common");
  const [inspecting, setInspecting] = useState<SpellCollectionCardData | null>(null);

  const groups = groupByTier(cards);
  const fractions = tierFractions(cards);
  const visible = groups[tierFilter];
  const inspectingView = inspecting ? cardTileView(inspecting) : null;

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-3 flex gap-1 rounded-lg border-4 border-gilt bg-tavern-panel p-1">
        {TIER_ORDER.map((tier) => (
          <button
            key={tier}
            type="button"
            onClick={() => setTierFilter(tier)}
            className={`flex-1 rounded-md px-2 py-2 text-center font-display text-[10px] uppercase tracking-widest transition-colors ${
              tierFilter === tier
                ? "bg-ember text-parchment"
                : "text-parchment-dim hover:bg-tavern-plank hover:text-parchment"
            }`}
          >
            {TIER_LABEL[tier]}
            <div className="font-mono text-[10px] normal-case tracking-normal">
              {fractions[tier].discovered}/{fractions[tier].total}
            </div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {visible.map((card) => (
          <SpellCollectionCard key={card.cardId} card={card} onTap={() => setInspecting(card)} />
        ))}
      </div>

      {inspecting && inspectingView ? (
        <CardInspectModal onClose={() => setInspecting(null)}>
          <div className="mb-3 aspect-[3/4] w-full overflow-hidden rounded-md bg-tavern-plank-dark">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={inspectingView.artPath}
              alt=""
              className={`h-full w-full object-cover ${inspectingView.artClassName}`}
            />
          </div>
          <p className="font-display text-sm font-semibold uppercase tracking-wide text-gilt-bright">
            {inspecting.name}
          </p>
          {isDiscovered(inspecting) ? (
            <>
              <p className="mt-0.5 font-mono text-xs text-parchment-dim">
                {TIER_LABEL[inspecting.tier]} · {inspecting.castingTime === "A" ? "Action" : "Reaction"} ·{" "}
                {inspecting.target} · drawn ×{inspecting.drawCount}
              </p>
              <p className="mt-2 font-body text-sm text-parchment">{inspecting.effectText}</p>
            </>
          ) : (
            <p className="mt-1 font-body text-sm text-parchment-dim">
              {TIER_LABEL[inspecting.tier]} · not yet drawn.
            </p>
          )}
          {ownCollection ? (
            // key by card so switching which card is inspected remounts the
            // row fresh — its committed-score state is seeded from props
            // once per mount (issue #300).
            <SpellCardRatingRow
              key={inspecting.cardId}
              cardId={inspecting.cardId}
              myRating={inspecting.myRating}
              isCastEligible={inspecting.isCastEligible}
            />
          ) : null}
          <button
            type="button"
            onClick={() => setInspecting(null)}
            className="mt-3 w-full rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
          >
            Close
          </button>
        </CardInspectModal>
      ) : null}
    </div>
  );
}
