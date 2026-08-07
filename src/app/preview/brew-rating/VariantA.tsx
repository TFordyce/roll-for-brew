"use client";

// PROTOTYPE — throwaway.
//
// Variant A — "Bookmark ribbon": the panel is an open parchment page, the
// tab handle is a wax-sealed ribbon bookmark sticking out of the right
// edge. Interaction: discrete tap-per-star — click any star to set the
// rating to that value, hover previews the fill before you commit.

import { useState } from "react";
import { PixelStar } from "./PixelStar";
import { MOCK_ROUND, MOCK_SUBMITTED_SCORE, type PanelState } from "./mockData";

export function VariantA({
  open,
  onToggleOpen,
  state,
  score,
  onSetScore,
}: {
  open: boolean;
  onToggleOpen: () => void;
  state: PanelState;
  score: number;
  onSetScore: (n: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const displayScore = state === "rated" ? MOCK_SUBMITTED_SCORE : (hover ?? score);

  return (
    <>
      {/* Tab handle — a ribbon bookmark, always visible on the right edge */}
      <button
        type="button"
        onClick={onToggleOpen}
        aria-label="Open brew rating"
        className="fixed right-0 top-1/3 z-40 flex flex-col items-center gap-1 rounded-l-md border-2 border-r-0 border-gilt bg-ember px-2 py-4 shadow-[0_4px_12px_rgb(0_0_0_/_0.4)] transition-transform hover:-translate-x-1"
        style={{ writingMode: "vertical-rl" }}
      >
        <span className="font-display text-[10px] uppercase tracking-widest text-parchment">Rate Brew</span>
        {state === "pending" ? <span className="h-2 w-2 rounded-full bg-gilt-bright" style={{ writingMode: "horizontal-tb" }} /> : null}
      </button>

      {/* Panel */}
      <div
        className={`fixed right-0 top-0 z-50 h-full w-[300px] border-l-4 border-gilt bg-parchment shadow-[-8px_0_24px_rgb(0_0_0_/_0.5)] transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col p-5 text-tavern-panel">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold uppercase tracking-widest">Brewer&apos;s Notepad</h2>
            <button type="button" onClick={onToggleOpen} className="font-display text-lg leading-none" aria-label="Close">
              ×
            </button>
          </div>

          {state === "none" ? (
            <p className="mt-8 text-center text-sm italic text-tavern-panel/60">
              Nothing to rate right now — check back after the next round.
            </p>
          ) : (
            <>
              <p className="mb-1 text-sm">
                {MOCK_ROUND.brewerName} brewed for {MOCK_ROUND.roomLabel}
              </p>
              <p className="mb-6 text-xs text-tavern-panel/60">Resolved {MOCK_ROUND.resolvedAgo}</p>

              <div className="mb-2 flex gap-1" onMouseLeave={() => setHover(null)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
                    onMouseEnter={() => setHover(n)}
                    onClick={() => onSetScore(n)}
                  >
                    <PixelStar lit={n <= displayScore} size={36} />
                  </button>
                ))}
              </div>

              <p className="text-xs text-tavern-panel/60">
                {state === "rated"
                  ? "Submitted — tap a star to change it until the next round resolves."
                  : "Tap a star to rate."}
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
