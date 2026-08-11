"use client";

import type { SpellCollectionCard as SpellCollectionCardData } from "@/lib/supabase/spellCards";
import { cardTileView, TIER_BORDER, TIER_LABEL } from "@/lib/spellCollection";

/**
 * One grid tile — discovered cards show full-color art, name, tier badge,
 * and a ×N draw-count badge; undiscovered cards dim the art and drop the
 * draw-count badge, keeping the effect a surprise (issue #134 acceptance
 * criteria). The discovered/dimming/badge decisions themselves live in
 * `cardTileView` (lib/spellCollection.ts) so they're unit-tested without
 * rendering.
 */
export function SpellCollectionCard({ card, onTap }: { card: SpellCollectionCardData; onTap: () => void }) {
  const view = cardTileView(card);
  return (
    <button
      type="button"
      onClick={onTap}
      className={`group relative flex flex-col overflow-hidden rounded-md border-[3px] bg-tavern-panel-dark text-left ${TIER_BORDER[card.tier]}`}
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-tavern-plank-dark">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={view.artPath} alt="" className={`h-full w-full object-cover ${view.artClassName}`} />
        {view.showDrawBadge ? (
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
          view.discovered ? "text-parchment" : "text-parchment-dim"
        }`}
      >
        {card.name}
      </p>
    </button>
  );
}
