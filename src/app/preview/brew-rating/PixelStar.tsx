/**
 * PROTOTYPE — throwaway. 8-bit style pixel star sprite, drawn as a grid of
 * <rect>s from a plain-text pattern rather than a placeholder image, so it
 * actually renders crisp square pixels at any size. `lit` swaps the fill
 * from a greyed-out silhouette to gold; `size` is the rendered px size.
 */

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

const COLS = STAR_PATTERN[0]!.length;
const ROWS = STAR_PATTERN.length;

export function PixelStar({
  lit,
  size = 28,
  litColor = "#f5c542",
  unlitColor = "#4a4a52",
  className = "",
}: {
  lit: boolean;
  size?: number;
  litColor?: string;
  unlitColor?: string;
  className?: string;
}) {
  const fill = lit ? litColor : unlitColor;

  return (
    <svg
      width={size}
      height={(size / COLS) * ROWS}
      viewBox={`0 0 ${COLS} ${ROWS}`}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden="true"
    >
      {STAR_PATTERN.flatMap((row, y) =>
        [...row].map((char, x) =>
          char === "X" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} /> : null,
        ),
      )}
      {lit ? (
        // single bright highlight pixel — sells the "gold" over "yellow" read
        <rect x={4} y={3} width={1} height={1} fill="#fff2c2" />
      ) : null}
    </svg>
  );
}
