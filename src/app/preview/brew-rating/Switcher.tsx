"use client";

// PROTOTYPE — throwaway. Floating bottom-centre bar for cycling design
// variants, per the /prototype skill's UI convention. Visually distinct
// (high-contrast pill) so it's obviously not part of the design being
// judged. This whole route already 404s outside local dev (see page.tsx),
// so there's no separate production gate needed here.

import { useEffect } from "react";

export function Switcher<T extends string>({
  keys,
  labels,
  current,
  onChange,
  title,
}: {
  keys: T[];
  labels: Record<T, string>;
  current: T;
  onChange: (next: T) => void;
  title: string;
}) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (target?.isContentEditable) return;

      const idx = keys.indexOf(current);
      if (e.key === "ArrowLeft") onChange(keys[(idx - 1 + keys.length) % keys.length]!);
      if (e.key === "ArrowRight") onChange(keys[(idx + 1) % keys.length]!);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [keys, current, onChange]);

  const idx = keys.indexOf(current);

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full bg-black/85 px-4 py-2 text-white shadow-[0_4px_16px_rgb(0_0_0_/_0.5)]">
      <span className="text-[10px] uppercase tracking-widest text-white/50">{title}</span>
      <button type="button" onClick={() => onChange(keys[(idx - 1 + keys.length) % keys.length]!)} className="px-1 text-lg leading-none">
        ←
      </button>
      <span className="min-w-[140px] text-center text-xs font-semibold">
        {current} — {labels[current]}
      </span>
      <button type="button" onClick={() => onChange(keys[(idx + 1) % keys.length]!)} className="px-1 text-lg leading-none">
        →
      </button>
    </div>
  );
}
