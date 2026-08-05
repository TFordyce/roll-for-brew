import { type DieShape } from "@/lib/game/dieShape";

/**
 * Decorative die-shape icons for RollCalculation's rich mode (issue #167).
 * Geometry and gotchas copied verbatim from the validated prototype
 * (worktree-prototype-roll-calc-ui, commit 95bda4f, inlined into issue
 * #160's description) — see that issue for how the icosahedron vertices
 * were derived. DieShape itself lives in lib/game/dieShape.ts, not here —
 * parseDieShape needs to stay unit-testable without React/DOM.
 */
export type { DieShape };

const DIE_VIEWBOX: Record<DieShape, string> = {
  d4: "0 0 24 24",
  d6: "0 0 24 24",
  d20: "0 0 100 100",
};

const ICOSAHEDRON_VERTICES: [number, number][] = [
  [25.99, 63.86],
  [50.0, 94.86],
  [50.0, 5.14],
  [74.01, 36.14],
  [50.0, 22.28],
  [11.15, 27.57],
  [88.85, 72.43],
  [50.0, 77.72],
  [74.01, 63.86],
  [88.85, 27.57],
  [11.15, 72.43],
  [25.99, 36.14],
];

const ICOSAHEDRON_EDGES: [number, number][] = [
  [0, 1], [0, 4], [0, 5], [0, 8], [0, 10],
  [1, 6], [1, 7], [1, 8], [1, 10],
  [2, 3], [2, 4], [2, 5], [2, 9], [2, 11],
  [3, 6], [3, 7], [3, 9], [3, 11],
  [4, 5], [4, 8], [4, 9],
  [5, 10], [5, 11],
  [6, 7], [6, 8], [6, 9],
  [7, 10], [7, 11],
  [8, 9],
  [10, 11],
]; // eslint-disable-line prettier/prettier

function DieOutline({ shape }: { shape: DieShape }) {
  if (shape === "d4") return <polygon points="12,3 21,20 3,20" />;
  if (shape === "d6") return <rect x="4" y="4" width="16" height="16" rx="1.5" />;
  // d20: a mathematically-derived icosahedron wireframe, not a circle or an
  // arbitrary planar-graph SVG. Gotcha already hit once: no
  // vector-effect="non-scaling-stroke" on these <line>s — it pins the
  // stroke to a fixed absolute pixel width regardless of how far the
  // 100x100 viewBox is squeezed down to icon size, which fuses all 30 edges
  // into filled blobs at small sizes. Left at default strokeLinecap (butt)
  // too, so edges meet in sharp points rather than piling into rounded dots
  // at each of the 12 vertices.
  return (
    <g stroke="currentColor" strokeWidth="1.5" fill="none">
      {ICOSAHEDRON_EDGES.map(([a, b], i) => {
        const [x1, y1] = ICOSAHEDRON_VERTICES[a]!;
        const [x2, y2] = ICOSAHEDRON_VERTICES[b]!;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
    </g>
  );
}

/**
 * A die outline with its value layered on top. `className` sizes the icon
 * (e.g. `h-5 w-5`) — the SVG itself just fills its container via the
 * viewBox. The d4's number needs a slight downward nudge: the triangle's
 * visual middle (its incenter, for points "12,3 21,20 3,20") sits below the
 * box's naive geometric center because the apex eats space at the top.
 */
export function DieIcon({ shape, value, className = "h-5 w-5" }: { shape: DieShape; value: number; className?: string }) {
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center text-parchment-dim ${className}`}>
      <svg viewBox={DIE_VIEWBOX[shape]} fill="none" stroke="currentColor" strokeWidth="1.5" className="h-full w-full">
        <DieOutline shape={shape} />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-parchment ${shape === "d4" ? "translate-y-[10%]" : ""}`}>
        {value}
      </span>
    </span>
  );
}
