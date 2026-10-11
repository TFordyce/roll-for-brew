"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getSlotAssignments, type PropKey } from "@/lib/backdropShuffle";

const SCENE_WIDTH = 1376;
const SCENE_HEIGHT = 768;

export const PROP_IMAGES: Record<PropKey, string> = {
  kettle: "/backdrop/props/kettle.png",
  teapot: "/backdrop/props/teapot.png",
  sugarBowl: "/backdrop/props/sugar-bowl.png",
  milkCarton: "/backdrop/props/milk-carton.png",
  coffeeJar: "/backdrop/props/coffee-jar.png",
  saucerStack: "/backdrop/props/saucer-stack.png",
};

export const PROP_ASPECT: Record<PropKey, number> = {
  kettle: 44 / 42,
  teapot: 52 / 36,
  sugarBowl: 39 / 32,
  milkCarton: 29 / 44,
  coffeeJar: 36 / 54,
  saucerStack: 45 / 30,
};

const PROP_SCALE: Record<PropKey, number> = {
  kettle: 1.1,
  teapot: 1,
  sugarBowl: 0.85,
  milkCarton: 1,
  coffeeJar: 1,
  saucerStack: 0.8,
};

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

export function computeSceneScale(containerWidth: number): number {
  if (containerWidth <= 0) return 1;
  return containerWidth / SCENE_WIDTH;
}

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

export function ParallaxBackdrop({ playerId }: { playerId: string }) {
  const reducedMotion = useReducedMotion();
  const steamFrameIndex = useKettleSteamFrame(reducedMotion);
  const slots = useMemo(() => getSlotAssignments(playerId), [playerId]);
  const kettleSlotIndex = slots.indexOf("kettle");
  const kettleAnchor = kettleSlotIndex !== -1 ? SLOT_ANCHORS[kettleSlotIndex] : null;

  const containerRef = useRef<HTMLDivElement>(null);
  const scale = useSceneScale(containerRef);

  return (
    <div ref={containerRef} className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
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
