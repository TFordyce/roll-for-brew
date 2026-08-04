"use client";

import { useState } from "react";
import { artFor, type CollectionCard, TOTAL_CATALOG_SIZE } from "./mockData";

/**
 * Variant C — "Display case spotlight". One enlarged card front-and-centre
 * (the inspect state *is* the default state, no modal/accordion), a
 * filmstrip of thumbnails below to jump around, and a circular "kettle
 * gauge" for completion instead of a text fraction. Structurally distinct
 * from A/B: no grid-first layout, one card visible at a time.
 */

const TIER_LABEL: Record<CollectionCard["tier"], string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
};

const TIER_RING: Record<CollectionCard["tier"], string> = {
  common: "stroke-parchment-dim",
  rare: "stroke-gilt-bright",
  epic: "stroke-ember-bright",
};

function CompletionGauge({ discovered, total }: { discovered: number; total: number }) {
  const pct = discovered / total;
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={radius} strokeWidth="6" className="fill-none stroke-tavern-plank-dark" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          strokeWidth="6"
          strokeLinecap="round"
          className="fill-none stroke-gilt-bright"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
        />
      </svg>
      <span className="absolute font-mono text-[10px] text-parchment">
        {discovered}/{total}
      </span>
    </div>
  );
}

export function VariantC({ cards, discoveredCount }: { cards: CollectionCard[]; discoveredCount: number }) {
  const [gridMode, setGridMode] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const active = cards[activeIndex]!;
  const discovered = active.drawCount > 0;

  return (
    <div className="w-full max-w-sm">
      <div className="mb-3 flex items-center justify-between">
        <CompletionGauge discovered={discoveredCount} total={TOTAL_CATALOG_SIZE} />
        <button
          type="button"
          onClick={() => setGridMode((v) => !v)}
          className="rounded-md border-2 border-gilt px-3 py-1.5 font-display text-[10px] uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
        >
          {gridMode ? "Spotlight view" : "Grid view"}
        </button>
      </div>

      {gridMode ? (
        <div className="grid grid-cols-4 gap-1.5">
          {cards.map((card, i) => (
            <button
              key={card.cardId}
              type="button"
              onClick={() => {
                setActiveIndex(i);
                setGridMode(false);
              }}
              className="aspect-[3/4] overflow-hidden rounded border-2 border-gilt-dark bg-tavern-plank-dark"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={artFor(card.cardId, i)}
                alt=""
                className={`h-full w-full object-cover ${card.drawCount > 0 ? "" : "grayscale brightness-[0.3]"}`}
              />
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="rounded-lg border-4 border-gilt bg-tavern-panel p-4 shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.5)]">
            <div className="relative mb-3 aspect-[3/4] w-full overflow-hidden rounded-md bg-tavern-plank-dark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={artFor(active.cardId, activeIndex)}
                alt=""
                className={`h-full w-full object-cover ${discovered ? "" : "grayscale brightness-[0.3] contrast-125"}`}
              />
              {discovered && active.drawCount > 1 ? (
                <span className="absolute right-2 top-2 rounded-full bg-ember px-2 py-1 font-mono text-xs text-parchment shadow-[0_0_0_1px_theme(colors.gilt.dark)]">
                  ×{active.drawCount}
                </span>
              ) : null}
            </div>
            <p className="font-display text-base font-semibold uppercase tracking-wide text-gilt-bright">
              {active.name}
            </p>
            {discovered ? (
              <>
                <p className="mt-0.5 font-mono text-xs text-parchment-dim">
                  {TIER_LABEL[active.tier]} · {active.castingTime === "A" ? "Action" : "Reaction"} · {active.target}
                </p>
                <p className="mt-2 font-body text-sm text-parchment">{active.effectText}</p>
              </>
            ) : (
              <p className="mt-1 font-body text-sm text-parchment-dim">
                {TIER_LABEL[active.tier]} · not yet drawn — effect hidden until discovered.
              </p>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setActiveIndex((i) => (i - 1 + cards.length) % cards.length)}
              className="rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
            >
              ← Prev
            </button>
            <span className="font-mono text-xs text-parchment-dim">
              {activeIndex + 1} / {cards.length}
            </span>
            <button
              type="button"
              onClick={() => setActiveIndex((i) => (i + 1) % cards.length)}
              className="rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
            >
              Next →
            </button>
          </div>

          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
            {cards.map((card, i) => (
              <button
                key={card.cardId}
                type="button"
                onClick={() => setActiveIndex(i)}
                className={`h-12 w-9 shrink-0 overflow-hidden rounded border-2 ${
                  i === activeIndex ? "border-gilt-bright" : "border-gilt-dark/60"
                } ${TIER_RING[card.tier]}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={artFor(card.cardId, i)}
                  alt=""
                  className={`h-full w-full object-cover ${card.drawCount > 0 ? "" : "grayscale brightness-[0.35]"}`}
                />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
