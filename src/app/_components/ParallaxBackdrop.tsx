"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getSlotAssignments, type PropKey } from "@/lib/backdropShuffle";

// Native pixel size of back-layer.png. The whole scene (background + props)
// is laid out at this fixed resolution, then scaled as one rigid unit and
// anchored to the bottom of the viewport (see computeSceneScale / the
// bottom-anchored scene wrapper below) — so props stay glued to the same
// spot on the art at every width, and the counter surface never gets pushed
// above the fold on tall/narrow viewports (issue #95).
//
// The scale is derived from container *width* only, never height. A
// height-inclusive "cover" scale (the previous approach) forces the scene to
// grow tall enough to cover portrait viewports, which crops most of its
// width away — on a typical phone that crop window ends up entirely between
// the leftmost and rightmost prop slots, i.e. every prop disappears. Fitting
// to width guarantees the full width (every slot) stays visible; any excess
// scene height above the container is simply cropped from the top (the
// bottom-anchored counter/shelf row stays put) instead of redistributing the
// crop across both edges.
const SCENE_WIDTH = 1376;
const SCENE_HEIGHT = 768;

const PROP_IMAGES: Record<PropKey, string> = {
  kettle: "/backdrop/props/kettle.png",
  teapot: "/backdrop/props/teapot.png",
  sugarBowl: "/backdrop/props/sugar-bowl.png",
  milkCarton: "/backdrop/props/milk-carton.png",
  coffeeJar: "/backdrop/props/coffee-jar.png",
  saucerStack: "/backdrop/props/saucer-stack.png",
};

// Natural pixel dimensions of each sprite (public/backdrop/props/*.png),
// used to keep aspect ratio when scaling every prop to a shared on-counter
// height.
const PROP_ASPECT: Record<PropKey, number> = {
  kettle: 252 / 243,
  teapot: 302 / 209,
  sugarBowl: 227 / 190,
  milkCarton: 170 / 253,
  coffeeJar: 194 / 304,
  saucerStack: 259 / 173,
};

// Kettle and saucer-stack are both wide-relative-to-tall sprites (near-1:1
// and 3:2 aspect ratios respectively), so at the shared slot height they
// read visibly wider than the others — scaled down a bit here so their
// footprint matches the rest of the row rather than tightening the slot
// spacing to compensate.
const PROP_SCALE: Record<PropKey, number> = {
  kettle: 1.1,
  teapot: 1,
  sugarBowl: 0.85,
  milkCarton: 1,
  coffeeJar: 1,
  saucerStack: 0.8,
};

// Per-slot anchor: x/y position in px within the fixed SCENE_WIDTH x
// SCENE_HEIGHT canvas, and a pixel height (the whole canvas is scaled as one
// unit, so these are fixed art-native sizes, not viewport-relative). Slot
// indices 3 and 4 used to sit on the counter directly behind the centered
// "Room" card, so they're relocated up onto the back shelf instead —
// smaller, since the shelf reads as further from the viewer than the
// counter-top. Their x stays well inboard of the shelf's support brackets
// (~19%/81% of scene width) and clear of the middle post (~46-48%), so they
// actually rest on the shelf's surface rather than floating past its edge.
// The counter anchors likewise sit a few points in from the counter's own
// edges rather than running right up to them, and skip the two central
// positions (behind the "Room" card) for a deliberately uneven row.
type SlotAnchor = { x: number; y: number; heightPx: number };

const SLOT_ANCHORS: SlotAnchor[] = [
  { x: 0.12 * SCENE_WIDTH, y: 0.61 * SCENE_HEIGHT, heightPx: 88 },
  { x: 0.235 * SCENE_WIDTH, y: 0.61 * SCENE_HEIGHT, heightPx: 88 },
  { x: 0.35 * SCENE_WIDTH, y: 0.61 * SCENE_HEIGHT, heightPx: 88 },
  { x: 0.295 * SCENE_WIDTH, y: 0.302 * SCENE_HEIGHT, heightPx: 58 },
  { x: 0.74 * SCENE_WIDTH, y: 0.309 * SCENE_HEIGHT, heightPx: 58 },
  { x: 0.65 * SCENE_WIDTH, y: 0.61 * SCENE_HEIGHT, heightPx: 88 },
  { x: 0.765 * SCENE_WIDTH, y: 0.61 * SCENE_HEIGHT, heightPx: 88 },
  { x: 0.88 * SCENE_WIDTH, y: 0.61 * SCENE_HEIGHT, heightPx: 88 },
];

const STEAM_FRAMES = [1, 2, 3, 4, 5].map((n) => `/backdrop/steam/steam-${n}.png`);
const STEAM_FRAME_MS = 500;
const STEAM_MIN_DELAY_MS = 45_000;
const STEAM_MAX_DELAY_MS = 90_000;

/**
 * Scale factor to make a SCENE_WIDTH-wide box fit its container's width
 * exactly — width only, deliberately never height (see the SCENE_WIDTH
 * comment above for why: a height-inclusive scale crops the horizontal
 * extent that every prop slot lives in on tall/narrow viewports).
 */
export function computeSceneScale(containerWidth: number): number {
  if (containerWidth <= 0) return 1;
  return containerWidth / SCENE_WIDTH;
}

/** Recomputes computeSceneScale on resize via ResizeObserver. */
function useSceneScale(containerRef: RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    function updateScale(width: number) {
      setScale(computeSceneScale(width));
    }

    updateScale(node.clientWidth);

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      updateScale(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef]);

  return scale;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  return reduced;
}

/** Cycles the kettle through an infrequent steam puff; null while idle. */
function useKettleSteamFrame(reducedMotion: boolean): number | null {
  const [frameIndex, setFrameIndex] = useState<number | null>(null);

  useEffect(() => {
    if (reducedMotion) return;

    let puffTimer: ReturnType<typeof setTimeout>;
    let frameTimer: ReturnType<typeof setInterval>;
    let cancelled = false;

    function schedulePuff() {
      const delay = STEAM_MIN_DELAY_MS + Math.random() * (STEAM_MAX_DELAY_MS - STEAM_MIN_DELAY_MS);
      puffTimer = setTimeout(runPuff, delay);
    }

    function runPuff() {
      if (cancelled) return;
      let index = 0;
      setFrameIndex(index);
      frameTimer = setInterval(() => {
        index += 1;
        if (index >= STEAM_FRAMES.length) {
          clearInterval(frameTimer);
          setFrameIndex(null);
          schedulePuff();
          return;
        }
        setFrameIndex(index);
      }, STEAM_FRAME_MS);
    }

    schedulePuff();
    return () => {
      cancelled = true;
      clearTimeout(puffTimer);
      clearInterval(frameTimer);
    };
  }, [reducedMotion]);

  return frameIndex;
}

/**
 * Fixed (non-parallax) tavern-counter backdrop (issue #82), replacing the
 * tiled wood-plank placeholder from issue #64. Prop-to-slot assignment is
 * shuffled once per player per day (see backdropShuffle.ts) so the counter
 * looks different day to day without shifting mid-session.
 */
export function ParallaxBackdrop({ playerId }: { playerId: string }) {
  const reducedMotion = useReducedMotion();
  const steamFrameIndex = useKettleSteamFrame(reducedMotion);
  const slots = useMemo(() => getSlotAssignments(playerId), [playerId]);
  const kettleSlotIndex = slots.indexOf("kettle");
  const kettleAnchor = kettleSlotIndex !== -1 ? SLOT_ANCHORS[kettleSlotIndex] : null;

  const containerRef = useRef<HTMLDivElement>(null);
  const scale = useSceneScale(containerRef);

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div
        className="absolute bottom-0 left-1/2"
        style={{
          width: SCENE_WIDTH,
          height: SCENE_HEIGHT,
          transform: `translate(-50%, 0) scale(${scale})`,
          transformOrigin: "bottom center",
        }}
      >
        <img
          src="/backdrop/back-layer.png"
          alt=""
          className="absolute inset-0 h-full w-full [image-rendering:pixelated]"
        />

        {slots.map((propKey, slotIndex) => {
          if (!propKey) return null;
          const anchor = SLOT_ANCHORS[slotIndex]!;
          return (
            <img
              key={slotIndex}
              src={PROP_IMAGES[propKey]}
              alt=""
              className="absolute w-auto [image-rendering:pixelated]"
              style={{
                left: anchor.x,
                top: anchor.y,
                height: anchor.heightPx * PROP_SCALE[propKey],
                aspectRatio: PROP_ASPECT[propKey],
                transform: "translate(-50%, -100%)",
              }}
            />
          );
        })}

        {steamFrameIndex !== null && kettleAnchor ? (
          <img
            src={STEAM_FRAMES[steamFrameIndex]}
            alt=""
            className="absolute w-auto [image-rendering:pixelated]"
            style={{
              left: kettleAnchor.x,
              top: kettleAnchor.y,
              height: kettleAnchor.heightPx * 1.6,
              transform: "translate(-50%, -145%)",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
