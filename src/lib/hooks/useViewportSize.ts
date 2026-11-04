"use client";

import { useEffect, useState } from "react";
import type { ViewportSize } from "@/lib/game/sceneGeometry";

// Server render has no viewport, so layout starts from a conservative phone
// size and settles on the real one after mount. Both the server and the first
// client render use this default, so hydration stays consistent.
export const DEFAULT_VIEWPORT: ViewportSize = { width: 375, height: 667 };

export type ViewportSource = {
  measure: () => ViewportSize;
  addEventListener: (type: "resize" | "orientationchange", listener: () => void) => void;
  removeEventListener: (type: "resize" | "orientationchange", listener: () => void) => void;
};

export function subscribeToViewportSize(
  source: ViewportSource,
  onChange: (size: ViewportSize) => void,
): () => void {
  const report = () => onChange(source.measure());

  report();
  source.addEventListener("resize", report);
  source.addEventListener("orientationchange", report);
  return () => {
    source.removeEventListener("resize", report);
    source.removeEventListener("orientationchange", report);
  };
}

// Measured from the document element, not `window.innerWidth`: the backdrop
// lays itself out in a `fixed inset-0` box, whose client box excludes the
// classic scrollbar. Reading the same box is what keeps the dice table's plank
// aligned with the art instead of sitting a scrollbar's width off.
function documentViewportSource(): ViewportSource {
  return {
    measure: () => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }),
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
  };
}

export function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(DEFAULT_VIEWPORT);

  useEffect(() => subscribeToViewportSize(documentViewportSource(), setSize), []);

  return size;
}
