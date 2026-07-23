"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSlotAssignments, type PropKey } from "@/lib/backdropShuffle";

const PROP_IMAGES: Record<PropKey, string> = {
  kettle: "/backdrop/props/kettle.png",
  teapot: "/backdrop/props/teapot.png",
  mugRack: "/backdrop/props/mug-rack.png",
  sugarBowl: "/backdrop/props/sugar-bowl.png",
  milkCarton: "/backdrop/props/milk-carton.png",
  coffeeJar: "/backdrop/props/coffee-jar.png",
  teaTowel: "/backdrop/props/tea-towel.png",
  saucerStack: "/backdrop/props/saucer-stack.png",
};

// Natural pixel dimensions of each sprite (public/backdrop/props/*.png),
// used to keep aspect ratio when scaling every prop to a shared on-counter
// height.
const PROP_ASPECT: Record<PropKey, number> = {
  kettle: 252 / 243,
  teapot: 302 / 209,
  mugRack: 366 / 160,
  sugarBowl: 227 / 190,
  milkCarton: 170 / 253,
  coffeeJar: 194 / 304,
  teaTowel: 322 / 269,
  saucerStack: 259 / 173,
};

// 8 evenly-spaced slot x-anchors (% of the counter width) and the shared
// counter-top y-anchor (% from the top of back-layer.png), picked by eye
// against the counter surface in that image.
const SLOT_X_PERCENT = [8, 20.5, 33, 45.5, 58, 70.5, 83, 92];
const COUNTER_TOP_PERCENT = 61;

const STEAM_FRAMES = [1, 2, 3, 4, 5].map((n) => `/backdrop/steam/steam-${n}.png`);
const STEAM_FRAME_MS = 500;
const STEAM_MIN_DELAY_MS = 45_000;
const STEAM_MAX_DELAY_MS = 90_000;

const BACK_LAYER_SHIFT_PX = 6;
const FOREGROUND_SHIFT_PX = 18;

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

function useParallaxOffset(reducedMotion: boolean): { x: number; y: number } {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      setOffset({ x: 0, y: 0 });
      return;
    }

    function handleMove(event: MouseEvent) {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setOffset({
          x: (event.clientX / window.innerWidth) * 2 - 1,
          y: (event.clientY / window.innerHeight) * 2 - 1,
        });
      });
    }

    window.addEventListener("mousemove", handleMove);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [reducedMotion]);

  return offset;
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
 * Two-layer parallax tavern-counter backdrop (issue #82), replacing the
 * tiled wood-plank placeholder from issue #64. Prop-to-slot assignment is
 * shuffled once per player per day (see backdropShuffle.ts) so the counter
 * looks different day to day without shifting mid-session.
 */
export function ParallaxBackdrop({ playerId }: { playerId: string }) {
  const reducedMotion = useReducedMotion();
  const offset = useParallaxOffset(reducedMotion);
  const steamFrameIndex = useKettleSteamFrame(reducedMotion);
  const slots = useMemo(() => getSlotAssignments(playerId), [playerId]);
  const kettleSlotIndex = slots.indexOf("kettle");

  const backX = offset.x * BACK_LAYER_SHIFT_PX;
  const backY = offset.y * BACK_LAYER_SHIFT_PX;
  const foreX = offset.x * FOREGROUND_SHIFT_PX;
  const foreY = offset.y * FOREGROUND_SHIFT_PX;

  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div
        className="absolute -inset-8 bg-cover bg-center [image-rendering:pixelated]"
        style={{
          backgroundImage: "url(/backdrop/back-layer.png)",
          transform: `translate3d(${backX}px, ${backY}px, 0)`,
        }}
      />

      <div className="absolute inset-0" style={{ transform: `translate3d(${foreX}px, ${foreY}px, 0)` }}>
        {slots.map((propKey, slotIndex) => (
          <img
            key={propKey}
            src={PROP_IMAGES[propKey]}
            alt=""
            className="absolute h-[8vw] max-h-[110px] min-h-[56px] w-auto [image-rendering:pixelated]"
            style={{
              left: `${SLOT_X_PERCENT[slotIndex]}%`,
              top: `${COUNTER_TOP_PERCENT}%`,
              aspectRatio: PROP_ASPECT[propKey],
              transform: "translate(-50%, -100%)",
            }}
          />
        ))}

        {steamFrameIndex !== null && kettleSlotIndex !== -1 ? (
          <img
            src={STEAM_FRAMES[steamFrameIndex]}
            alt=""
            className="absolute h-[13vw] max-h-[170px] w-auto [image-rendering:pixelated]"
            style={{
              left: `${SLOT_X_PERCENT[kettleSlotIndex]}%`,
              top: `${COUNTER_TOP_PERCENT}%`,
              transform: "translate(-50%, -145%)",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
