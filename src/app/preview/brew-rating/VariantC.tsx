"use client";

// PROTOTYPE — throwaway.
//
// Variant C — "Terminal quest-log": a CRT/scanline terminal panel, tab
// handle is a blinking cursor tab. Interaction: deliberate, keyboard-first
// — up/down (or 1-5 keys) cycle the pending score, a separate CONFIRM
// action commits it. No hover-preview, no drag: every change is a step,
// nothing commits until you say so.

import { useEffect, useState } from "react";
import { PixelStar } from "./PixelStar";
import { MOCK_ROUND, MOCK_SUBMITTED_SCORE, type PanelState } from "./mockData";

export function VariantC({
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
  const [pending, setPending] = useState(score || 3);
  const committed = state === "rated" ? MOCK_SUBMITTED_SCORE : score;

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (state !== "pending" && state !== "rated") return;
      if (e.key === "ArrowUp") setPending((p) => Math.min(5, p + 1));
      if (e.key === "ArrowDown") setPending((p) => Math.max(1, p - 1));
      if (/^[1-5]$/.test(e.key)) setPending(Number(e.key));
      if (e.key === "Enter") onSetScore(pending);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, state, pending, onSetScore]);

  return (
    <>
      {/* Tab handle — blinking cursor */}
      <button
        type="button"
        onClick={onToggleOpen}
        aria-label="Open brew rating"
        className="fixed right-0 top-1/2 z-40 flex items-center gap-2 border-2 border-r-0 border-[#3fff6b] bg-black px-3 py-3 font-mono text-[#3fff6b] shadow-[0_0_12px_rgb(63_255_107_/_0.4)] transition-transform hover:-translate-x-1"
      >
        {state === "pending" ? <span className="h-2 w-2 animate-pulse rounded-full bg-[#3fff6b]" /> : null}
        <span className="animate-pulse text-xs">▌RATE</span>
      </button>

      {/* Panel — CRT terminal */}
      <div
        className={`fixed right-0 top-0 z-50 h-full w-[300px] overflow-hidden border-l-4 border-[#3fff6b] bg-black font-mono text-[#3fff6b] shadow-[-8px_0_24px_rgb(0_0_0_/_0.6)] transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* scanlines */}
        <div
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            backgroundImage: "repeating-linear-gradient(0deg, #3fff6b 0px, transparent 1px, transparent 3px)",
          }}
        />

        <div className="relative flex h-full flex-col p-5">
          <div className="mb-4 flex items-center justify-between text-xs">
            <h2 className="uppercase tracking-widest">&gt; brew_log.exe</h2>
            <button type="button" onClick={onToggleOpen} aria-label="Close">
              [X]
            </button>
          </div>

          {state === "none" ? (
            <p className="mt-8 text-xs">
              &gt; No rateable round found.
              <br />
              &gt; Standing by...
            </p>
          ) : (
            <>
              <p className="mb-1 text-xs">&gt; BREWER: {MOCK_ROUND.brewerName}</p>
              <p className="mb-6 text-xs opacity-60">&gt; RESOLVED: {MOCK_ROUND.resolvedAgo}</p>

              <p className="mb-2 text-xs">&gt; SCORE:</p>
              <div className="mb-3 flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <PixelStar
                    key={n}
                    lit={n <= (state === "rated" && pending === score ? committed : pending)}
                    size={32}
                    litColor="#3fff6b"
                    unlitColor="#123a1e"
                  />
                ))}
              </div>

              <p className="mb-4 text-[11px] opacity-70">↑/↓ or 1-5 to select, ENTER to confirm</p>

              <div className="flex gap-2 text-[11px]">
                <button type="button" onClick={() => setPending((p) => Math.max(1, p - 1))} className="border border-[#3fff6b] px-2 py-1">
                  -
                </button>
                <button type="button" onClick={() => setPending((p) => Math.min(5, p + 1))} className="border border-[#3fff6b] px-2 py-1">
                  +
                </button>
                <button type="button" onClick={() => onSetScore(pending)} className="ml-auto border border-[#3fff6b] bg-[#3fff6b]/10 px-3 py-1">
                  CONFIRM
                </button>
              </div>

              {state === "rated" ? (
                <p className="mt-4 text-[11px] opacity-60">&gt; last submitted: {committed}/5 — editable until next round resolves.</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}
