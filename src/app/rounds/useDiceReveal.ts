"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/hooks/useReducedMotion";

export type DiceRevealEntrance = "landing" | "static";

export type DiceRevealState =
  | { phase: "idle" }
  | { phase: "rolling" }
  | { phase: "landed"; value: number; entrance: DiceRevealEntrance }
  | { phase: "dismissed" };

export type DiceRevealEvent =
  | { type: "rollSubmitted" }
  | { type: "rollResolved"; value: number }
  | { type: "dismiss" };

export const initialDiceRevealState: DiceRevealState = { phase: "idle" };

export function transitionDiceReveal(
  state: DiceRevealState,
  event: DiceRevealEvent,
  reducedMotion: boolean,
): DiceRevealState {
  if (event.type === "dismiss") {
    return state.phase === "landed" ? { phase: "dismissed" } : state;
  }
  if (event.type === "rollSubmitted") {
    return state.phase === "idle" ? { phase: "rolling" } : state;
  }
  if (event.type === "rollResolved") {
    return state.phase === "rolling"
      ? { phase: "landed", value: event.value, entrance: reducedMotion ? "static" : "landing" }
      : state;
  }
  return state;
}

export type DiceRevealController = {
  state: DiceRevealState;
  rollSubmitted: () => void;
  rollResolved: (value: number) => void;
  dismiss: () => void;
};

export function useDiceReveal(roundId: string): DiceRevealController {
  const [state, setState] = useState<DiceRevealState>(initialDiceRevealState);
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  useEffect(() => {
    setState(initialDiceRevealState);
  }, [roundId]);

  const dispatch = useCallback((event: DiceRevealEvent) => {
    setState((prev) => transitionDiceReveal(prev, event, reducedMotionRef.current));
  }, []);

  return useMemo(
    () => ({
      state,
      rollSubmitted: () => dispatch({ type: "rollSubmitted" }),
      rollResolved: (value: number) => dispatch({ type: "rollResolved", value }),
      dismiss: () => dispatch({ type: "dismiss" }),
    }),
    [state, dispatch],
  );
}
