"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/hooks/useReducedMotion";
import {
  SETTLE_TAIL_MS,
  flightWaapiKeyframes,
  settleWaapiKeyframes,
  simulateD20Throw,
  type DiceFlightTrack,
} from "@/lib/game/dicePhysics";
import type { DiceRevealEntrance } from "./useDiceReveal";
import { DIE_SIZE_PX, DieFaces } from "./DieFaces";

// When the die mounts already landed (remount into a landed machine state) the
// flight replays from this far into the track: a short drop-and-bounce entry.
const MOUNTED_LANDED_MS = 500;

// Drop keyframes that start after fromMs, renormalised to a 0..1 timeline.
function sliceKeyframes(
  keyframes: { offset: number; transform: string }[],
  durationMs: number,
  fromMs: number,
): { offset: number; transform: string }[] {
  if (fromMs <= 0) return keyframes;
  const start = fromMs / durationMs;
  return keyframes
    .filter((k) => k.offset >= start)
    .map((k) => ({ offset: (k.offset - start) / (1 - start), transform: k.transform }));
}

export function AnimatedDie({
  phase,
  value,
  entrance,
  onDismiss,
}: {
  phase: "rolling" | "landed";
  value: number | undefined;
  entrance: DiceRevealEntrance;
  onDismiss: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const spinRef = useRef<HTMLSpanElement | null>(null);
  const flightRef = useRef<Animation | null>(null);
  const settleRef = useRef<Animation | null>(null);
  const trackRef = useRef<DiceFlightTrack | null>(null);
  const pendingValueRef = useRef<number | undefined>(undefined);
  const settledRef = useRef(false);
  const [revealedValue, setRevealedValue] = useState<number | undefined>(undefined);

  const startSettle = useCallback((settled: number) => {
    if (settledRef.current) {
      setRevealedValue(settled);
      return;
    }
    settledRef.current = true;
    flightRef.current?.cancel();
    flightRef.current = null;
    // the value rides the face through the settle snap: the reveal moment
    setRevealedValue(settled);
    const el = spinRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    settleRef.current = el.animate(settleWaapiKeyframes(track), {
      duration: SETTLE_TAIL_MS,
      fill: "both",
    });
  }, []);

  // Flight playback runs once per mount; reduced-motion users get today's
  // static appear instead. The matchMedia read here (not the hook's state)
  // because the hook resolves a tick after mount and must not start motion.
  useEffect(() => {
    const el = spinRef.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const track = simulateD20Throw();
    trackRef.current = track;
    const keyframes = flightWaapiKeyframes(track);
    const fromMs = phase === "landed" ? MOUNTED_LANDED_MS : 0;
    const flight = el.animate(sliceKeyframes(keyframes, track.durationMs, fromMs), {
      duration: track.durationMs - fromMs,
      easing: "linear",
      fill: "both",
    });
    flight.onfinish = () => {
      const pending = pendingValueRef.current;
      if (pending !== undefined) startSettle(pending);
    };
    flightRef.current = flight;
    return () => {
      flight.cancel();
      settleRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- playback is per-mount; later machine transitions only deliver the value
  }, []);

  // Honour a reduced-motion preference that arrives mid-choreography: cut the
  // playback and leave the die where it is, revealing the value if landed.
  // Idempotent under re-runs (late value deliveries land the same way).
  useEffect(() => {
    if (!reducedMotion) return;
    flightRef.current?.cancel();
    flightRef.current = null;
    settleRef.current?.cancel();
    settledRef.current = true;
    if (phase === "landed" && value !== undefined) setRevealedValue(value);
  }, [reducedMotion, phase, value]);

  // The machine's resolve: the value is known, but the face waits for the
  // settle moment. A landed correction after settle just swaps the number.
  useEffect(() => {
    if (phase !== "landed" || value === undefined) return;
    if (entrance === "static" || settledRef.current) {
      startSettle(value);
      return;
    }
    pendingValueRef.current = value;
    const flight = flightRef.current;
    if (flight === null || flight.playState === "finished") startSettle(value);
  }, [phase, value, entrance, startSettle]);

  const landed = phase === "landed";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        if (landed) onDismiss();
      }}
      disabled={!landed}
      aria-hidden={landed ? undefined : true}
      aria-label={landed ? "Back to the roll row" : undefined}
      title={landed ? "Back to the roll row" : undefined}
      className={`relative block shrink-0 [perspective:220px] ${landed ? "cursor-pointer" : "cursor-default"}`}
      style={{ width: DIE_SIZE_PX, height: DIE_SIZE_PX }}
    >
      <span ref={spinRef} className="absolute inset-0 block [transform-style:preserve-3d]">
        <DieFaces value={revealedValue} />
      </span>
    </button>
  );
}
