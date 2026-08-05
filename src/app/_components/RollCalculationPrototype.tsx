"use client";

/**
 * PROTOTYPE — throwaway, do not build on top of this file.
 *
 * Answers: "what should the roll-calculation UI look like when a spell card
 * has changed the roll or the modifier?" — an enhancement to the existing
 * <RollCalculation> (src/app/_components/RollCalculation.tsx), which today
 * only ever shows a bare "roll + modifier = total".
 *
 * Three variants, switchable via ?variant=A|B|C, mounted as an extra section
 * on the real Test Room page (/admin/test-room) so it sits against the
 * actual chrome/density rather than a blank page. Data is fixture rows, not
 * live game state — hitting every one of these cases (nat1, nat20, a flat
 * spell bonus, a multiplier, a hard "set to X", a bonus/penalty die, and a
 * forced reroll) through real play would mean orchestrating eight separate
 * rounds.
 *
 * Shared visual vocabulary applied across all three variants (per the ask):
 * the modifier value is bold+underlined, the roll sits inside a wireframe
 * d20, a plain (non-dice) spell effect gets a small twinkling sparkle, and a
 * dice-based bonus/penalty ("+1d4", "-1d4") gets a wireframe d4 (triangular
 * pyramid) instead — the variants disagree on layout, not on this iconography.
 *
 * See the issue this is scoping for the question and the eventual verdict.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { classifyRollCalculation } from "@/lib/game/rollCalculation";
import { CardFrame } from "@/app/_components/CardFrame";

type ModifierEffectFixture = {
  name: string;
  detail: string; // human-readable, e.g. "×2" or "set to 0" or "+1d4 (rolled 3)"
  dieShape?: "d4" | "d6"; // present when this effect adds/subtracts a rolled die rather than a flat/multiplier/set value
};

type Fixture = {
  label: string;
  playerName: string;
  baseModifier: number;
  finalModifier: number;
  roll: number;
  originalRoll?: number; // present only when a reroll swapped the die
  rerollSource?: string;
  modifierEffects?: ModifierEffectFixture[];
};

const FIXTURES: Fixture[] = [
  {
    label: "Plain roll — unaffected",
    playerName: "Priya",
    baseModifier: 2,
    finalModifier: 2,
    roll: 14,
  },
  {
    label: "Nat 1",
    playerName: "Dev",
    baseModifier: 3,
    finalModifier: 3,
    roll: 1,
  },
  {
    label: "Nat 20",
    playerName: "Sam",
    baseModifier: -1,
    finalModifier: -1,
    roll: 20,
  },
  {
    label: "Flat spell bonus (+2)",
    playerName: "Priya",
    baseModifier: 2,
    finalModifier: 4,
    roll: 11,
    modifierEffects: [{ name: "Lucky Brew", detail: "+2" }],
  },
  {
    label: "Multiplier spell effect (×2)",
    playerName: "Owen",
    baseModifier: 3,
    finalModifier: 6,
    roll: 9,
    modifierEffects: [{ name: "Double Down", detail: "×2" }],
  },
  {
    label: 'Hard "set" spell effect',
    playerName: "Mara",
    baseModifier: 4,
    finalModifier: 0,
    roll: 13,
    modifierEffects: [{ name: "Milky Brew", detail: "set to 0" }],
  },
  {
    label: "Bonus die (+1d4)",
    playerName: "Owen",
    baseModifier: 2,
    finalModifier: 5,
    roll: 10,
    modifierEffects: [{ name: "Ember Boost", detail: "+1d4 (rolled 3)", dieShape: "d4" }],
  },
  {
    label: "Penalty die (-1d4)",
    playerName: "Mara",
    baseModifier: 4,
    finalModifier: 2,
    roll: 15,
    modifierEffects: [{ name: "Curse of Stumbling", detail: "-1d4 (rolled 2)", dieShape: "d4" }],
  },
  {
    label: "Stacked effects (flat + dice penalty)",
    playerName: "Priya",
    baseModifier: 2,
    finalModifier: 3,
    roll: 8,
    modifierEffects: [
      { name: "Lucky Brew", detail: "+2" },
      { name: "Curse of Stumbling", detail: "-1d4 (rolled 1)", dieShape: "d4" },
    ],
  },
  {
    label: "Forced reroll",
    playerName: "Dev",
    baseModifier: 3,
    finalModifier: 3,
    roll: 17,
    originalRoll: 4,
    rerollSource: "Chaos Die",
  },
  {
    label: "Reroll landed on nat 1",
    playerName: "Sam",
    baseModifier: -1,
    finalModifier: -1,
    roll: 1,
    originalRoll: 12,
    rerollSource: "Chaos Die",
  },
];

const VARIANT_KEYS = ["A", "B", "C"] as const;
type VariantKey = (typeof VARIANT_KEYS)[number];
const VARIANT_NAMES: Record<VariantKey, string> = {
  A: "Inline chip",
  B: "Stacked breakdown line",
  C: "Expand on demand",
};

function isAffected(f: Fixture): boolean {
  return (f.modifierEffects?.length ?? 0) > 0 || f.originalRoll !== undefined;
}

// ---------------------------------------------------------------------------
// Shared iconography — reused by all three variants below.
// ---------------------------------------------------------------------------

/** The d20-roll value, sat inside a wireframe icosahedron-ish outline. */
function RollValue({ value }: { value: number }) {
  return (
    <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center" title="d20 roll">
      <svg viewBox="0 0 24 24" className="absolute inset-0 h-full w-full text-parchment-dim/50" fill="none" stroke="currentColor" strokeWidth="1">
        <polygon points="12,1 22,7 22,17 12,23 2,17 2,7" />
        <polyline points="2,7 12,13 22,7" />
        <polyline points="12,13 12,23" />
        <polyline points="12,1 12,13" />
      </svg>
      <span className="relative z-10 font-mono text-[11px] text-parchment">{value}</span>
    </span>
  );
}

/** The modifier value — bold + underlined, distinct from the plain roll number. */
function ModifierValue({ value }: { value: number }) {
  return <span className="font-bold text-parchment underline decoration-parchment-dim/60 underline-offset-2">{value}</span>;
}

/** A quiet twinkle — a plain (non-dice) spell effect touched this number. */
function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 animate-pulse text-fuchsia-300" fill="currentColor" aria-hidden>
      <path d="M12 1 L14.2 9.8 L23 12 L14.2 14.2 L12 23 L9.8 14.2 L1 12 L9.8 9.8 Z" />
    </svg>
  );
}

/** A wireframe d4 (triangular pyramid) — a bonus/penalty die was added behind this number. */
function D4Icon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-sky-300" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <polygon points="12,2 22,20 2,20" />
      <polyline points="12,2 12,20" />
      <polyline points="12,2 7,20" />
    </svg>
  );
}

/** Picks the right icon for a single modifier-effect fixture. */
function EffectIcon({ effect }: { effect: ModifierEffectFixture }) {
  return effect.dieShape ? <D4Icon /> : <SparkleIcon />;
}

// ---------------------------------------------------------------------------
// Variant A — Inline chip: the existing "roll + modifier = total" line grows
// a small inline chip right next to whichever term a spell touched. Nothing
// moves for unaffected rows; affected rows get slightly wider.
// ---------------------------------------------------------------------------
function VariantA({ f }: { f: Fixture }) {
  const calc = classifyRollCalculation(f.roll, f.finalModifier);

  if (calc.kind === "nat1" || calc.kind === "nat20") {
    return (
      <span
        className={`font-display text-xs font-semibold uppercase tracking-widest ${
          calc.kind === "nat1" ? "text-red-500" : "text-gilt-bright"
        }`}
      >
        {calc.kind === "nat1" ? "Nat 1" : "Nat 20"}
      </span>
    );
  }

  const operator = calc.modifier >= 0 ? "+" : "-";
  const modifierChip =
    f.modifierEffects && f.modifierEffects.length > 0 ? (
      <span
        className="ml-1 inline-flex flex-wrap items-center gap-1 rounded-sm border border-gilt-dark bg-tavern-panel-dark px-1 py-0.5 text-[10px] uppercase tracking-wide text-gilt-bright"
        title={f.modifierEffects.map((e) => `${e.name}: ${e.detail}`).join(", ")}
      >
        {f.modifierEffects.map((e) => (
          <span key={e.name} className="inline-flex items-center gap-0.5">
            <EffectIcon effect={e} />
            {e.name}
          </span>
        ))}
      </span>
    ) : null;

  const rollChip =
    f.originalRoll !== undefined ? (
      <span
        className="ml-1 rounded-sm border border-gilt-dark bg-tavern-panel-dark px-1 py-0.5 text-[10px] uppercase tracking-wide text-parchment-dim"
        title={`Rerolled by ${f.rerollSource}`}
      >
        was {f.originalRoll}
      </span>
    ) : null;

  return (
    <span className="flex flex-wrap items-center justify-end gap-x-1 whitespace-nowrap font-mono text-xs text-parchment-dim">
      <RollValue value={calc.roll} />
      {rollChip}
      {operator} <ModifierValue value={Math.abs(calc.modifier)} />
      {modifierChip}
      = <span className="text-parchment">{calc.total}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Variant B — Stacked breakdown: the top line always looks exactly like
// today's compact calculation. Affected rows grow a second, smaller line
// underneath spelling out each contributing effect in plain language.
// ---------------------------------------------------------------------------
function VariantB({ f }: { f: Fixture }) {
  const calc = classifyRollCalculation(f.roll, f.finalModifier);

  const breakdownRows: { key: string; icon: React.JSX.Element | null; text: string }[] = [];
  if (f.originalRoll !== undefined) {
    breakdownRows.push({
      key: "reroll",
      icon: null,
      text: `Roll: ${f.originalRoll} → ${f.roll} (${f.rerollSource})`,
    });
  }
  for (const e of f.modifierEffects ?? []) {
    breakdownRows.push({ key: e.name, icon: <EffectIcon effect={e} />, text: `${e.name}: ${e.detail}` });
  }

  if (calc.kind === "nat1" || calc.kind === "nat20") {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span
          className={`font-display text-xs font-semibold uppercase tracking-widest ${
            calc.kind === "nat1" ? "text-red-500" : "text-gilt-bright"
          }`}
        >
          {calc.kind === "nat1" ? "Nat 1" : "Nat 20"}
        </span>
        {breakdownRows.map((row) => (
          <span key={row.key} className="flex items-center gap-1 whitespace-nowrap text-[10px] text-parchment-dim/80">
            {row.icon}
            {row.text}
          </span>
        ))}
      </div>
    );
  }

  const operator = calc.modifier >= 0 ? "+" : "-";

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="flex items-center gap-1 whitespace-nowrap font-mono text-xs text-parchment-dim">
        <RollValue value={calc.roll} /> {operator} <ModifierValue value={Math.abs(calc.modifier)} /> ={" "}
        <span className="text-parchment">{calc.total}</span>
      </span>
      {breakdownRows.map((row) => (
        <span key={row.key} className="flex items-center gap-1 whitespace-nowrap text-[10px] text-parchment-dim/80">
          {row.icon}
          {row.text}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant C — Expand on demand: the roster row is identical to today's for
// every entry, affected or not — a small "i" marker appears next to affected
// ones only. Clicking/tapping it toggles a breakdown panel below that row.
// Keeps the default roster as dense as it is today.
// ---------------------------------------------------------------------------
function VariantC({ f }: { f: Fixture }) {
  const [expanded, setExpanded] = useState(false);
  const calc = classifyRollCalculation(f.roll, f.finalModifier);
  const affected = isAffected(f);

  const summary =
    calc.kind === "nat1" || calc.kind === "nat20" ? (
      <span
        className={`font-display text-xs font-semibold uppercase tracking-widest ${
          calc.kind === "nat1" ? "text-red-500" : "text-gilt-bright"
        }`}
      >
        {calc.kind === "nat1" ? "Nat 1" : "Nat 20"}
      </span>
    ) : (
      <span className="flex items-center gap-1 whitespace-nowrap font-mono text-xs text-parchment-dim">
        <RollValue value={calc.roll} /> {calc.modifier >= 0 ? "+" : "-"}{" "}
        <ModifierValue value={Math.abs(calc.modifier)} /> = <span className="text-parchment">{calc.total}</span>
      </span>
    );

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1.5">
        {summary}
        {affected ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label="Show what affected this roll"
            className="flex h-4 w-4 items-center justify-center rounded-full border border-gilt-bright text-[9px] font-bold text-gilt-bright hover:bg-gilt-bright hover:text-tavern-panel-dark"
          >
            i
          </button>
        ) : null}
      </span>
      {affected && expanded ? (
        <div className="flex flex-col gap-0.5 rounded-sm border border-gilt-dark bg-tavern-panel-dark px-2 py-1 text-[10px] text-parchment-dim">
          {f.originalRoll !== undefined ? (
            <p>
              Roll rerolled: {f.originalRoll} → {f.roll} ({f.rerollSource})
            </p>
          ) : null}
          {f.modifierEffects?.map((e) => (
            <p key={e.name} className="flex items-center gap-1">
              <EffectIcon effect={e} />
              {e.name}: {e.detail}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const VARIANT_COMPONENTS: Record<VariantKey, (props: { f: Fixture }) => React.JSX.Element> = {
  A: VariantA,
  B: VariantB,
  C: VariantC,
};

function PrototypeSwitcher({ current }: { current: VariantKey }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function go(next: VariantKey) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("variant", next);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  function cycle(delta: 1 | -1) {
    const index = VARIANT_KEYS.indexOf(current);
    const next = VARIANT_KEYS[(index + delta + VARIANT_KEYS.length) % VARIANT_KEYS.length]!;
    go(next);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border-2 border-fuchsia-400 bg-black/90 px-4 py-2 shadow-lg">
      <button
        type="button"
        onClick={() => cycle(-1)}
        className="text-fuchsia-300 hover:text-fuchsia-100"
        aria-label="Previous variant"
      >
        ←
      </button>
      <span className="font-mono text-xs text-fuchsia-200">
        {current} — {VARIANT_NAMES[current]}
      </span>
      <button
        type="button"
        onClick={() => cycle(1)}
        className="text-fuchsia-300 hover:text-fuchsia-100"
        aria-label="Next variant"
      >
        →
      </button>
    </div>
  );
}

export function RollCalculationPrototype() {
  if (process.env.NODE_ENV === "production") return null;

  const searchParams = useSearchParams();
  const raw = searchParams.get("variant")?.toUpperCase();
  const current: VariantKey = (VARIANT_KEYS as readonly string[]).includes(raw ?? "")
    ? (raw as VariantKey)
    : "A";
  const Variant = VARIANT_COMPONENTS[current];

  return (
    <>
      <CardFrame title="Roll Calculation UI — prototype (spell-affected rolls)">
        <ul className="divide-y divide-gilt-dark/40">
          {FIXTURES.map((f) => (
            <li key={f.label} className="flex items-center justify-between gap-3 py-2">
              <div className="flex flex-col">
                <span className="font-body text-sm text-parchment">{f.playerName}</span>
                <span className="text-[10px] text-parchment-dim/70">{f.label}</span>
              </div>
              <Variant f={f} />
            </li>
          ))}
        </ul>
      </CardFrame>
      <PrototypeSwitcher current={current} />
    </>
  );
}
