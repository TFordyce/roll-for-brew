"use client";

import { useEffect, useMemo, useState } from "react";
import { getSlotAssignments, type PropKey } from "@/lib/backdropShuffle";

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

// Per-slot anchor: x-position (% of scene width), y-anchor (% from top of
// back-layer.png), and a size class. Slot indices 3 and 4 used to sit on the
// counter directly behind the centered "Room" card, so they're relocated up
// onto the back shelf (one either side of the middle support post) instead —
// smaller, since the shelf reads as further from the viewer than the
// counter-top. The rest keep their original counter positions; skipping the
// two central ones leaves the counter row deliberately unevenly spaced.
type SlotAnchor = { xPercent: number; topPercent: number; sizeClass: string };

const SLOT_ANCHORS: SlotAnchor[] = [
  { xPercent: 8, topPercent: 61, sizeClass: "h-[8vw] max-h-[110px] min-h-[56px]" },
  { xPercent: 20.5, topPercent: 61, sizeClass: "h-[8vw] max-h-[110px] min-h-[56px]" },
  { xPercent: 33, topPercent: 61, sizeClass: "h-[8vw] max-h-[110px] min-h-[56px]" },
  { xPercent: 18, topPercent: 30, sizeClass: "h-[5.5vw] max-h-[75px] min-h-[38px]" },
  { xPercent: 82, topPercent: 30, sizeClass: "h-[5.5vw] max-h-[75px] min-h-[38px]" },
  { xPercent: 70.5, topPercent: 61, sizeClass: "h-[8vw] max-h-[110px] min-h-[56px]" },
  { xPercent: 83, topPercent: 61, sizeClass: "h-[8vw] max-h-[110px] min-h-[56px]" },
  { xPercent: 92, topPercent: 61, sizeClass: "h-[8vw] max-h-[110px] min-h-[56px]" },
];

const STEAM_FRAMES = [1, 2, 3, 4, 5].map((n) => `/backdrop/steam/steam-${n}.png`);
const STEAM_FRAME_MS = 500;
const STEAM_MIN_DELAY_MS = 45_000;
const STEAM_MAX_DELAY_MS = 90_000;

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

  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div
        className="absolute -inset-8 bg-cover bg-center [image-rendering:pixelated]"
        style={{ backgroundImage: "url(/backdrop/back-layer.png)" }}
      />

      <div className="absolute inset-0">
        {slots.map((propKey, slotIndex) => {
          if (!propKey) return null;
          const anchor = SLOT_ANCHORS[slotIndex]!;
          return (
            <img
              key={slotIndex}
              src={PROP_IMAGES[propKey]}
              alt=""
              className={`absolute w-auto [image-rendering:pixelated] ${anchor.sizeClass}`}
              style={{
                left: `${anchor.xPercent}%`,
                top: `${anchor.topPercent}%`,
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
            className="absolute h-[13vw] max-h-[170px] w-auto [image-rendering:pixelated]"
            style={{
              left: `${kettleAnchor.xPercent}%`,
              top: `${kettleAnchor.topPercent}%`,
              transform: "translate(-50%, -145%)",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
