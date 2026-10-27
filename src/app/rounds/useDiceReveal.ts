"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  | { type: "resolverOutputArrived"; value: number }
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
    if (state.phase === "rolling") {
      return { phase: "landed", value: event.value, entrance: reducedMotion ? "static" : "landing" };
    }
    if (state.phase === "landed" && state.value !== event.value) {
      return { ...state, value: event.value };
    }
    return state;
  }
  if (event.type === "resolverOutputArrived") {
    if (state.phase === "landed" && state.value !== event.value) {
      return { phase: "dismissed" };
    }
    return state;
  }
  return state;
}

export type DiceRevealInputs = {
  rollSubmitted: () => void;
  rollResolved: (value: number) => void;
  resolverOutputArrived: (value: number) => void;
  dismiss: () => void;
};

export type DiceRevealController = DiceRevealInputs & { state: DiceRevealState };

export function createDiceRevealController(options: {
  onStateChange: (state: DiceRevealState) => void;
  getReducedMotion: () => boolean;
}): DiceRevealInputs & { getState: () => DiceRevealState; reset: () => void } {
  let state = initialDiceRevealState;
  const adopt = (next: DiceRevealState) => {
    if (next === state) return;
    state = next;
    options.onStateChange(state);
  };
  const dispatch = (event: DiceRevealEvent) => {
    adopt(transitionDiceReveal(state, event, options.getReducedMotion()));
  };
  return {
    getState: () => state,
    reset: () => adopt(initialDiceRevealState),
    rollSubmitted: () => dispatch({ type: "rollSubmitted" }),
    rollResolved: (value: number) => dispatch({ type: "rollResolved", value }),
    resolverOutputArrived: (value: number) => dispatch({ type: "resolverOutputArrived", value }),
    dismiss: () => dispatch({ type: "dismiss" }),
  };
}

export function useDiceReveal(roundId: string | null): DiceRevealController {
  const [state, setState] = useState<DiceRevealState>(initialDiceRevealState);
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  const [controller] = useState(() =>
    createDiceRevealController({
      onStateChange: setState,
      getReducedMotion: () => reducedMotionRef.current,
    }),
  );

  useEffect(() => {
    controller.reset();
  }, [roundId, controller]);

  return useMemo(
    () => ({
      state,
      rollSubmitted: controller.rollSubmitted,
      rollResolved: controller.rollResolved,
      resolverOutputArrived: controller.resolverOutputArrived,
      dismiss: controller.dismiss,
    }),
    [state, controller],
  );
}
