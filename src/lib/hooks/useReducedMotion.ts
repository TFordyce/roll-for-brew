"use client";

import { useEffect, useState } from "react";

export type ReducedMotionQuery = {
  matches: boolean;
  addEventListener: (type: "change", listener: (event: { matches: boolean }) => void) => void;
  removeEventListener: (type: "change", listener: (event: { matches: boolean }) => void) => void;
};

export function subscribeToPreferredReducedMotion(
  query: ReducedMotionQuery,
  onChange: (matches: boolean) => void,
): () => void {
  onChange(query.matches);
  const listener = (event: { matches: boolean }) => onChange(event.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    return subscribeToPreferredReducedMotion(query, setReduced);
  }, []);

  return reduced;
}
