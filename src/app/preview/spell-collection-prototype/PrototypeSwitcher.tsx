"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * PROTOTYPE-ONLY floating variant switcher (ticket #124). Bottom-centre
 * pill: ← label → cycling `?variant=` in the URL, plus arrow-key support.
 * Not part of the design being evaluated — deliberately high-contrast so
 * it reads as tooling, not UI.
 */
export function PrototypeSwitcher({
  variants,
  current,
}: {
  variants: { key: string; label: string }[];
  current: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const index = Math.max(0, variants.findIndex((v) => v.key === current));

  function go(nextIndex: number) {
    const wrapped = (nextIndex + variants.length) % variants.length;
    const params = new URLSearchParams(searchParams.toString());
    params.set("variant", variants[wrapped]!.key);
    router.replace(`?${params.toString()}`);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement;
      const isEditable =
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (isEditable) return;
      if (e.key === "ArrowLeft") go(index - 1);
      if (e.key === "ArrowRight") go(index + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-black px-4 py-2 font-mono text-xs text-lime-300 shadow-[0_0_0_2px_#0f0,0_8px_24px_rgb(0_0_0_/_0.6)]">
      <button type="button" onClick={() => go(index - 1)} className="px-1 hover:text-white" aria-label="Previous variant">
        ←
      </button>
      <span>
        {variants[index]!.key} — {variants[index]!.label}
      </span>
      <button type="button" onClick={() => go(index + 1)} className="px-1 hover:text-white" aria-label="Next variant">
        →
      </button>
    </div>
  );
}
