"use client";

// PROTOTYPE — throwaway. Orchestrates the three Brew Rating panel
// variants plus a data-state switcher, both URL-driven so a specific
// combination is shareable/reload-stable:
//   ?variant=A|B|C   — which design (defaults A)
//   &state=none|pending|rated — which of the three things it must
//                                communicate (defaults pending)

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";
import { Switcher } from "./Switcher";
import { PANEL_STATE_KEYS, PANEL_STATE_LABEL, type PanelState } from "./mockData";

const VARIANT_KEYS = ["A", "B", "C"] as const;
type VariantKey = (typeof VARIANT_KEYS)[number];

const VARIANT_LABEL: Record<VariantKey, string> = {
  A: "Bookmark ribbon — tap-per-star",
  B: "Pushpin corkboard — drag-across",
  C: "Terminal quest-log — keypad",
};

export function BrewRatingPreview() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const variant = (searchParams.get("variant") as VariantKey | null) ?? "A";
  const panelState = (searchParams.get("state") as PanelState | null) ?? "pending";

  const [open, setOpen] = useState(true);
  const [score, setScore] = useState(0);

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(key, value);
      router.replace(`/preview/brew-rating?${params.toString()}`);
    },
    [router, searchParams],
  );

  const props = {
    open,
    onToggleOpen: () => setOpen((o) => !o),
    state: panelState,
    score,
    onSetScore: setScore,
  };

  return (
    <main className="relative isolate min-h-screen bg-tavern-plank">
      <ParallaxBackdrop playerId="preview" />

      <div className="p-8">
        <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
          Brew Rating — panel prototype
        </h1>
        <p className="mt-2 max-w-lg text-sm text-parchment-dim">
          Wayfinder ticket #202. Three structurally different takes on the slide-out rating panel — flip with the
          bar below (or ← / →). Use the state buttons to see the three things the panel needs to say.
        </p>

        <div className="mt-4 flex gap-2">
          {PANEL_STATE_KEYS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setParam("state", s)}
              className={`rounded-md border-2 px-3 py-1 font-display text-xs uppercase tracking-widest ${
                panelState === s
                  ? "border-gilt-bright bg-ember text-parchment"
                  : "border-gilt/40 bg-transparent text-parchment-dim"
              }`}
            >
              {PANEL_STATE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {variant === "A" ? <VariantA {...props} /> : null}
      {variant === "B" ? <VariantB {...props} /> : null}
      {variant === "C" ? <VariantC {...props} /> : null}

      <Switcher
        keys={[...VARIANT_KEYS]}
        labels={VARIANT_LABEL}
        current={variant}
        onChange={(v) => setParam("variant", v)}
        title="Design"
      />
    </main>
  );
}
