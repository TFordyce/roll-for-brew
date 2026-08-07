"use client";

// PROTOTYPE — throwaway.
//
// Variant B — "Pushpin corkboard": the panel is a small pinned index card,
// the tab handle is a pushpin peeking from the edge. Interaction:
// drag-across — press anywhere on the star strip and drag; the fill
// follows your finger/cursor and snaps to the nearest whole star,
// matching Uber's swipe-to-rate gesture.

import { useRef, useState } from "react";
import { PixelStar } from "./PixelStar";
import { MOCK_ROUND, MOCK_SUBMITTED_SCORE, type PanelState } from "./mockData";

export function VariantB({
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
  const [dragging, setDragging] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const displayScore = state === "rated" ? MOCK_SUBMITTED_SCORE : (dragging ?? score);

  function scoreFromPointer(clientX: number) {
    const strip = stripRef.current;
    if (!strip) return 1;
    const rect = strip.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.max(1, Math.min(5, Math.ceil(ratio * 5)));
  }

  function handlePointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragging(scoreFromPointer(e.clientX));
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (dragging === null) return;
    setDragging(scoreFromPointer(e.clientX));
  }
  function handlePointerUp() {
    if (dragging !== null) onSetScore(dragging);
    setDragging(null);
  }

  return (
    <>
      {/* Tab handle — a pushpin, offset lower on the edge */}
      <button
        type="button"
        onClick={onToggleOpen}
        aria-label="Open brew rating"
        className="fixed right-0 top-1/2 z-40 flex items-center gap-2 rounded-l-full border-2 border-r-0 border-[#8a5a3a] bg-[#c9762f] py-3 pl-3 pr-2 shadow-[0_4px_12px_rgb(0_0_0_/_0.4)] transition-transform hover:-translate-x-1"
      >
        {state === "pending" ? <span className="h-2 w-2 rounded-full bg-gilt-bright" /> : null}
        <span className="h-3 w-3 rounded-full border border-[#5c3a20] bg-[#e04a3f]" />
      </button>

      {/* Panel — a pinned card, not full-height */}
      <div
        className={`fixed right-4 top-24 z-50 w-[260px] origin-top-right rounded-sm border-2 border-[#8a5a3a] bg-[#fdf6e3] shadow-[0_10px_20px_rgb(0_0_0_/_0.5)] transition-all duration-300 ease-out ${
          open ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0 pointer-events-none"
        }`}
      >
        <div className="relative p-4 text-[#3a2a1a]">
          <span className="absolute -top-3 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border border-[#5c3a20] bg-[#e04a3f]" />
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-xs font-semibold uppercase tracking-widest">Brew Rating</h2>
            <button type="button" onClick={onToggleOpen} className="text-sm leading-none" aria-label="Close">
              ×
            </button>
          </div>

          {state === "none" ? (
            <p className="py-4 text-center text-xs italic text-[#3a2a1a]/60">Nothing to rate right now.</p>
          ) : (
            <>
              <p className="mb-3 text-xs">
                {MOCK_ROUND.brewerName} — {MOCK_ROUND.resolvedAgo}
              </p>

              <div
                ref={stripRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className="mb-2 flex touch-none gap-1 rounded bg-black/5 p-2"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <PixelStar key={n} lit={n <= displayScore} size={30} />
                ))}
              </div>
              <p className="text-[11px] text-[#3a2a1a]/60">
                {state === "rated" ? "Drag to change your rating." : "Drag across the stars to rate."}
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
