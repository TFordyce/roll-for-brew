"use client";

/**
 * PROTOTYPE — throwaway, do not build on top of this file.
 *
 * Answers: "what should the roll-calculation UI look like when a spell card
 * has changed the roll or the modifier?" — an enhancement to the existing
 * <RollCalculation> (src/app/_components/RollCalculation.tsx), which today
 * only ever shows a bare "roll + modifier = total".
 *
 * Fixtures are grounded in the real spell_card_effects catalog (supabase/
 * migrations/0032_spell_card_effects.sql), not invented names — flat/
 * multiplier/set effects fold into a single "modifier" value before this
 * component ever sees them (src/lib/game/modifierBucket.ts), but
 * `dice_modifier` (only ever 1d4 or 1d6 in the catalog — Six Sugars, Cold
 * Tea, Slipped Spoon; no d8/d10/d12 anywhere) is a genuinely separate
 * additive term the total doesn't otherwise account for, and `advantage`/
 * `disadvantage` (Sugar Rush, Fortune's Flavour, Slipped Spoon) are a
 * roll-twice-keep-one mechanic on the roll itself, not a modifier change.
 *
 * This went through a few rounds of feedback (see git history on this
 * branch for the earlier A/B/C layout comparison, since superseded):
 * settled on one combined layout — inline "roll (+adv/dis) + modifier +
 * dice-effect(s) = total" line, with a caster-attributed badge per spell
 * effect underneath (name only, no icon — the icon lives in the equation
 * term itself for dice effects). Die shapes are plain geometric outlines
 * (circle/triangle/square) with the rolled/kept value layered inside, not
 * literal wireframe polyhedra — simpler reads better at icon size than the
 * geometrically-accurate but fussier Wikimedia sourced shapes tried
 * earlier (still in research/wireframe-dice-icons.md if that direction
 * comes back).
 */

import { CardFrame } from "@/app/_components/CardFrame";
import { classifyRollCalculation } from "@/lib/game/rollCalculation";

type SpellEffectKind = "flat" | "multiplier" | "set" | "dice" | "advantage" | "disadvantage";

type SpellEffectFixture = {
  cardName: string; // real spell_cards.name, e.g. "Lucky Sip", "Cold Tea"
  casterName: string;
  kind: SpellEffectKind;
  detail: string; // human-readable, for the badge's title tooltip
  dieShape?: "d4" | "d6"; // only present when kind === "dice"
  dieValue?: number; // the rolled sub-value, only present when kind === "dice"
};

type Fixture = {
  label: string;
  playerName: string;
  baseModifier: number;
  finalModifier: number; // already composed from any flat/multiplier/set effects
  roll: number; // the kept d20 roll (post advantage/disadvantage, if any)
  discardedRoll?: number; // the other d20 from an advantage/disadvantage pair
  spellEffects?: SpellEffectFixture[];
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
    label: "Lucky Sip — flat +3, self-cast",
    playerName: "Priya",
    baseModifier: 2,
    finalModifier: 5,
    roll: 11,
    spellEffects: [{ cardName: "Lucky Sip", casterName: "Priya", kind: "flat", detail: "+3" }],
  },
  {
    label: "Brewer's Blessing — flat +5, cast on target",
    playerName: "Owen",
    baseModifier: 1,
    finalModifier: 6,
    roll: 9,
    spellEffects: [{ cardName: "Brewer's Blessing", casterName: "Dev", kind: "flat", detail: "+5" }],
  },
  {
    label: "Double Shot — ×2, self-cast",
    playerName: "Dev",
    baseModifier: 3,
    finalModifier: 6,
    roll: 8,
    spellEffects: [{ cardName: "Double Shot", casterName: "Dev", kind: "multiplier", detail: "×2" }],
  },
  {
    label: "Milky Brew — set to 0, cast on target",
    playerName: "Mara",
    baseModifier: 4,
    finalModifier: 0,
    roll: 13,
    spellEffects: [{ cardName: "Milky Brew", casterName: "Sam", kind: "set", detail: "set to 0" }],
  },
  {
    label: "Six Sugars — +1d6, self-cast",
    playerName: "Owen",
    baseModifier: 2,
    finalModifier: 2,
    roll: 10,
    spellEffects: [
      { cardName: "Six Sugars", casterName: "Owen", kind: "dice", dieShape: "d6", dieValue: 4, detail: "+1d6" },
    ],
  },
  {
    label: "Cold Tea — target side (flat -3)",
    playerName: "Mara",
    baseModifier: 4,
    finalModifier: 1,
    roll: 15,
    spellEffects: [{ cardName: "Cold Tea", casterName: "Priya", kind: "flat", detail: "-3" }],
  },
  {
    label: "Cold Tea — caster side (+1d4)",
    playerName: "Priya",
    baseModifier: 2,
    finalModifier: 2,
    roll: 9,
    spellEffects: [
      { cardName: "Cold Tea", casterName: "Priya", kind: "dice", dieShape: "d4", dieValue: 3, detail: "+1d4" },
    ],
  },
  {
    label: "Slipped Spoon — target side (disadvantage)",
    playerName: "Dev",
    baseModifier: 3,
    finalModifier: 3,
    roll: 6,
    discardedRoll: 14,
    spellEffects: [{ cardName: "Slipped Spoon", casterName: "Sam", kind: "disadvantage", detail: "disadvantage" }],
  },
  {
    label: "Slipped Spoon — caster side (+1d4)",
    playerName: "Sam",
    baseModifier: -1,
    finalModifier: -1,
    roll: 12,
    spellEffects: [
      { cardName: "Slipped Spoon", casterName: "Sam", kind: "dice", dieShape: "d4", dieValue: 2, detail: "+1d4" },
    ],
  },
  {
    label: "Sugar Rush — advantage, self-cast",
    playerName: "Owen",
    baseModifier: 2,
    finalModifier: 2,
    roll: 18,
    discardedRoll: 7,
    spellEffects: [{ cardName: "Sugar Rush", casterName: "Owen", kind: "advantage", detail: "advantage" }],
  },
  {
    label: "Fortune's Flavour — advantage, cast on target",
    playerName: "Mara",
    baseModifier: 4,
    finalModifier: 4,
    roll: 19,
    discardedRoll: 5,
    spellEffects: [{ cardName: "Fortune's Flavour", casterName: "Priya", kind: "advantage", detail: "advantage" }],
  },
  {
    label: "Sugar Rush — advantage roll lands on nat 20",
    playerName: "Dev",
    baseModifier: 3,
    finalModifier: 3,
    roll: 20,
    discardedRoll: 13,
    spellEffects: [{ cardName: "Sugar Rush", casterName: "Dev", kind: "advantage", detail: "advantage" }],
  },
];

// ---------------------------------------------------------------------------
// Shared iconography.
// ---------------------------------------------------------------------------

/** A plain geometric outline per die shape — not a literal wireframe polyhedron, just legible at icon size. */
function DieOutline({ shape }: { shape: "d4" | "d6" | "d20" }) {
  if (shape === "d4") return <polygon points="12,3 21,20 3,20" />;
  if (shape === "d6") return <rect x="4" y="4" width="16" height="16" rx="1.5" />;
  return <circle cx="12" cy="12" r="9.5" />;
}

/**
 * A die value — its shape outline with the actual rolled/kept number
 * layered in the middle. Used both for the base d20 roll (with `struck` for
 * the discarded half of an advantage/disadvantage pair) and for a dice
 * spell-effect term inline in the calculation.
 */
function DieValue({
  shape,
  value,
  struck = false,
  size = "h-5 w-5",
  textSize = "text-[10px]",
  tone = "text-parchment-dim/60",
  valueTone = "text-parchment",
}: {
  shape: "d4" | "d6" | "d20";
  value: number;
  struck?: boolean;
  size?: string;
  textSize?: string;
  tone?: string;
  valueTone?: string;
}) {
  return (
    <span
      className={`relative inline-flex ${size} shrink-0 items-center justify-center ${struck ? "opacity-40" : ""}`}
      title={`${struck ? "discarded " : ""}${shape} roll`}
    >
      <svg
        viewBox="0 0 24 24"
        className={`absolute inset-0 h-full w-full ${struck ? "text-parchment-dim/30" : tone}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <DieOutline shape={shape} />
      </svg>
      <span className={`relative z-10 font-mono font-bold ${textSize} ${struck ? "text-parchment-dim line-through" : valueTone}`}>
        {value}
      </span>
    </span>
  );
}

/** The modifier value — bold + underlined, distinct from the die values either side of it. */
function ModifierValue({ value }: { value: number }) {
  return <span className="font-bold text-parchment underline decoration-parchment-dim/60 underline-offset-2">{value}</span>;
}

// ---------------------------------------------------------------------------
// The calculation line: roll (+ discarded adv/dis roll inline, not stacked)
// + modifier + any dice-effect term(s) = total.
// ---------------------------------------------------------------------------
function CalcLine({ f }: { f: Fixture }) {
  const calc = classifyRollCalculation(f.roll, f.finalModifier);
  const diceEffects = (f.spellEffects ?? []).filter((e) => e.kind === "dice");
  const diceSum = diceEffects.reduce((sum, e) => sum + (e.dieValue ?? 0), 0);

  const rollTerm = (
    <span className="flex items-center gap-1">
      {f.discardedRoll !== undefined ? <DieValue shape="d20" value={f.discardedRoll} struck /> : null}
      <DieValue shape="d20" value={f.roll} size="h-6 w-6" textSize="text-[11px]" />
    </span>
  );

  if (calc.kind === "nat1" || calc.kind === "nat20") {
    return (
      <span className="flex flex-nowrap items-center gap-1.5 whitespace-nowrap">
        {rollTerm}
        <span
          className={`font-display text-xs font-semibold uppercase tracking-widest ${
            calc.kind === "nat1" ? "text-red-500" : "text-gilt-bright"
          }`}
        >
          {calc.kind === "nat1" ? "Nat 1" : "Nat 20"}
        </span>
      </span>
    );
  }

  const operator = calc.modifier >= 0 ? "+" : "-";
  const total = calc.total + diceSum;

  return (
    <span className="flex flex-nowrap items-center gap-1 whitespace-nowrap font-mono text-xs text-parchment-dim">
      {rollTerm}
      {operator} <ModifierValue value={Math.abs(calc.modifier)} />
      {diceEffects.map((e, i) => (
        <span key={i} className="flex items-center gap-0.5">
          + <DieValue shape={e.dieShape!} value={e.dieValue!} tone="text-sky-300/60" valueTone="text-sky-100" />
        </span>
      ))}
      = <span className="text-parchment">{total}</span>
    </span>
  );
}

/** One caster-attributed badge per spell effect — name only, no icon (the icon lives in the calc line for dice effects). */
function EffectBadges({ f }: { f: Fixture }) {
  if (!f.spellEffects || f.spellEffects.length === 0) return null;
  return (
    <>
      {f.spellEffects.map((e, i) => (
        <div key={i} className="flex items-center gap-1.5" title={e.detail}>
          <span className="rounded-full border border-gilt-dark bg-tavern-panel-dark px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gilt-bright">
            {e.cardName}
          </span>
          <span className="text-[10px] text-parchment-dim">{e.casterName}</span>
        </div>
      ))}
    </>
  );
}

export function RollCalculationVariants() {
  return (
    <CardFrame title="Roll Calculation UI — prototype (spell-affected rolls)">
      <ul className="divide-y divide-gilt-dark/40">
        {FIXTURES.map((f) => (
          <li key={f.label} className="flex items-center justify-between gap-3 py-2">
            <div className="flex flex-col">
              <span className="font-body text-sm text-parchment">{f.playerName}</span>
              <span className="text-[10px] text-parchment-dim/70">{f.label}</span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <CalcLine f={f} />
              <EffectBadges f={f} />
            </div>
          </li>
        ))}
      </ul>
    </CardFrame>
  );
}
