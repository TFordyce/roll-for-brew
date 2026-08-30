"use client";

// A single pixel-art star, lit (gold) or unlit (dim) — copied verbatim
// from the brew-rating prototype's grid (prototypes/brew-rating-panel.html,
// issue #202). Extracted from BrewRatingPanel into its own file so the
// Spell Collection card inspector (issue #300) can reuse the exact same
// star without importing the whole panel.

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

export function PixelStar({ lit, size = 26 }: { lit: boolean; size?: number }) {
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
