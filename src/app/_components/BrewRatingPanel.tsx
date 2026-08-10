"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { submitBrewRating, withdrawBrewRating, type RateableRound } from "@/lib/supabase/brewRatings";

// A hanging luggage-tag tab pinned to the screen edge that opens a pushpin
// notepad panel — the real-data wiring (issue #211, part of #208) for the
// standalone prototype at prototypes/brew-rating-panel.html (issue #202).
// That prototype tried four tab looks and three panel variants before
// settling on the hanging tag + pushpin-card combination reproduced here;
// only that final pick is kept, none of the prototype's other variants or
// its manual state buttons.

const STAR_PATTERN = [
  "....X....",
  "....X....",
  "...XXX...",
  "XXXXXXXXX",
  ".XXXXXXX.",
  "..XXXXX..",
  ".XX...XX.",
  "XX.....XX",
];

/** A single pixel-art star, lit (gold) or unlit (dim) — copied verbatim from the prototype's grid. */
function PixelStar({ lit, size = 26 }: { lit: boolean; size?: number }) {
  const cols = STAR_PATTERN[0]!.length;
  const rows = STAR_PATTERN.length;
  const fill = lit ? "#e8ce8f" : "#8a7a5c";
  return (
    <svg
      width={size}
      height={(size / cols) * rows}
      viewBox={`0 0 ${cols} ${rows}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {STAR_PATTERN.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === "X" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} /> : null,
        ),
      )}
      {lit ? <rect x={4} y={3} width={1} height={1} fill="#fff2c2" /> : null}
    </svg>
  );
}

// Matches ModifierAdjustmentList's (Settings) and stats/page.tsx's own
// formatTime convention.
function formatResolvedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function BrewRatingPanelActive({
  round,
  raterInitials,
}: {
  round: RateableRound;
  raterInitials: string;
}) {
  const [open, setOpen] = useState(false);
  // The server-committed score — changes only on a successful submit/
  // withdraw, never on a star preview tap. This is what the tab's
  // pending-dot reflects, so previewing a different star without
  // committing it can't make an already-rated round look unrated again
  // from outside the panel.
  const [committedScore, setCommittedScore] = useState(round.myScore);
  // The in-panel visual state: which star count is currently shown, and
  // whether the sign box is showing the signed stamp or the unsigned "Rate"
  // box. Starts matching committedScore, then diverges from it freely as
  // the player previews — reconciled back into committedScore only on an
  // actual submit/withdraw.
  const [score, setScore] = useState(round.myScore ?? 0);
  const [stamped, setStamped] = useState(round.myScore !== null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  function pickStar(n: number) {
    if (pending) return;
    setError(null);
    setScore(n);
    // Picking a star always stages a fresh, unconfirmed selection — any
    // existing stamp is retracted visually the moment the stars are
    // touched again, before any new commit (issue #211's acceptance
    // criteria). This is purely visual (stamped, not committedScore) — the
    // server-side rating, and the tab's pending-dot, are untouched until an
    // actual Rate/withdraw commit.
    setStamped(false);
  }

  async function toggleSign() {
    if (pending || (!stamped && score === 0)) return;
    setPending(true);
    setError(null);
    const supabase = createClient();
    try {
      if (stamped) {
        await withdrawBrewRating(supabase, round.roundId);
        setStamped(false);
        setCommittedScore(null);
      } else {
        await submitBrewRating(supabase, round.roundId, score);
        setStamped(true);
        setCommittedScore(score);
      }
    } catch {
      setError(stamped ? "Couldn't withdraw — try again." : "Couldn't submit — try again.");
    } finally {
      setPending(false);
    }
  }

  function closePanel() {
    setOpen(false);
  }

  // Clicking the panel's background — anything that isn't a button — closes
  // it, same as the ×. Buttons (stars, the sign box, the × itself) each
  // handle their own click and this delegate just steps aside for them.
  function handleBackgroundClick(event: React.MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    if (open) closePanel();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-label={open ? "Close Brew Rating" : "Open Brew Rating"}
        aria-expanded={open}
        className={`fixed right-0 top-[110px] z-[55] flex flex-col items-center gap-1 rounded border-2 border-gilt bg-parchment px-2.5 py-2.5 font-display text-[10px] uppercase leading-tight tracking-wider text-tavern-panel shadow-lg transition-transform duration-300 ease-out ${
          open ? "translate-x-[140%] rotate-[4deg]" : "translate-x-0 rotate-[4deg] hover:-translate-x-1"
        }`}
      >
        <span className="h-1.5 w-1.5 rounded-full border border-gilt-dark bg-tavern-plank" aria-hidden="true" />
        <span>
          Rate
          <br />
          Brew
        </span>
        {committedScore === null ? (
          <span className="h-2 w-2 rounded-full bg-gilt-bright" aria-hidden="true" data-testid="pending-dot" />
        ) : null}
      </button>

      <div
        role="dialog"
        aria-label="Brew Rating"
        aria-hidden={!open}
        onClick={handleBackgroundClick}
        className={`fixed right-4 top-[110px] z-50 w-64 rounded border-2 border-gilt-dark bg-parchment text-tavern-panel shadow-2xl transition-all duration-300 ease-out ${
          open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-[140%] opacity-0"
        }`}
      >
        <div className="relative p-4">
          <span
            className="absolute -top-3 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border border-ember bg-ember-bright"
            aria-hidden="true"
          />
          <div className="mb-3 flex items-center justify-between">
            <strong className="font-display text-xs uppercase tracking-widest">Brew Rating</strong>
            <button type="button" onClick={closePanel} aria-label="Close" className="text-base leading-none">
              ×
            </button>
          </div>

          <p className="mb-3 text-xs">
            {round.brewerDisplayName ?? round.brewerEmail} — {formatResolvedAt(round.resolvedAt)}
          </p>

          <div className="mb-3 flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
                onClick={() => pickStar(n)}
                disabled={pending}
                className="p-0 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <PixelStar lit={n <= score} />
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={toggleSign}
            disabled={pending || (!stamped && score === 0)}
            className={`block w-full rounded border-2 border-dashed px-2 py-2 text-center font-mono text-xs uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-40 ${
              stamped ? "border-solid border-ember bg-ember/10 font-bold text-ember" : "border-gilt-dark text-gilt-dark"
            }`}
          >
            {stamped ? `✓ ${raterInitials}` : "Rate"}
          </button>

          {error ? <p className="mt-2 text-[11px] text-ember-bright">{error}</p> : null}
        </div>
      </div>
    </>
  );
}

/**
 * Renders nothing when `round` is null — the "nothing to rate" state isn't
 * a message shown anywhere, the tab simply doesn't appear (issue #211's
 * acceptance criteria).
 */
export function BrewRatingPanel({
  round,
  raterInitials,
}: {
  round: RateableRound | null;
  raterInitials: string;
}) {
  if (!round) return null;
  // Keyed on roundId so a change to *which* round is rateable (a newer
  // round superseding the previous one, per "most recent round only")
  // remounts this component fresh instead of carrying over the previous
  // round's committed/preview state (issue #247) — all of committedScore,
  // score, stamped, and the pending-dot are seeded from useState once per
  // mount, so a clean remount is what resyncs them to the new round.
  return <BrewRatingPanelActive key={round.roundId} round={round} raterInitials={raterInitials} />;
}
