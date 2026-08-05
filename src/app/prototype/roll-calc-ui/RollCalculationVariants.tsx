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
 * term itself for dice effects).
 *
 * Sizing: this is an important result (it's what shows who won a round), so
 * it's deliberately rendered large/bold — secondary to the final winner
 * announcement elsewhere on the page, but not a hidden or squint-to-read
 * detail. The final total keeps the same bordered-pill treatment the live
 * app already uses for a decisive value (see RoundReveal.tsx's boxed roll
 * display) rather than being bare text — Nat 1/Nat 20 stay plain text
 * badges as they already are live, no box.
 *
 * d4/d6 are plain geometric outlines (triangle/square). The d20 is a
 * mathematically-derived icosahedron wireframe (see DieOutline below) — a
 * plain circle read as "just a badge" rather than a die, and the Wikimedia
 * `Icosahedron_graph.svg` tried before that was a real icosahedron but a
 * different, unrecognisable planar-graph layout — not what "a d20" actually
 * looks like.
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

type DieShape = "d4" | "d6" | "d20";

/** Native SVG coordinate space per shape. */
const DIE_VIEWBOX: Record<DieShape, string> = {
  d4: "0 0 24 24",
  d6: "0 0 24 24",
  d20: "0 0 100 100",
};

/**
 * d20 wireframe — the recognisable "hexagonal silhouette with an internal
 * triangle" look (what a d20 actually reads as), not the Wikimedia
 * `Icosahedron_graph.svg` tried earlier (a different, unrecognisable planar
 * graph layout of the same 12 vertices/30 edges).
 *
 * Derived directly rather than traced from an image: standard icosahedron
 * vertex coordinates ((0,±1,±φ), (±1,±φ,0), (±φ,0,±1), φ = golden ratio),
 * orthographically projected onto the plane perpendicular to the (1,1,1)
 * axis — which passes through the centroids of two opposite faces, since
 * that face's three vertices average to (φ²/3, φ²/3, φ²/3) — giving the
 * standard 3-fold-symmetric view. Verified by construction: every edge in
 * ICOSAHEDRON_EDGES connects two of the 12 canonical nearest-neighbour
 * pairs (checked against the icosahedron's known 30-edge adjacency, e.g.
 * vertex (0,1,φ)'s 5 neighbours all measure exactly distance 2 in 3D before
 * projection), not eyeballed from a reference picture.
 *
 * The raw projection above is a valid icosahedron view but lands at an
 * arbitrary rotation. The vertices below are that same projection rotated
 * ~22.24° about the projection center (50,50) so the front-facing triangle
 * (vertices 0/4/8) is apex-up and the whole figure is left-right symmetric —
 * the conventional way a d20 icon is drawn (hexagonal outline, one large
 * triangle facing the viewer, apex pointing straight up). This was an
 * orientation choice, not a geometry correctness fix.
 */
const ICOSAHEDRON_VERTICES: [number, number][] = [
  [25.99, 63.86],
  [50.00, 94.86],
  [50.00, 5.14],
  [74.01, 36.14],
  [50.00, 22.28],
  [11.15, 27.57],
  [88.85, 72.43],
  [50.00, 77.72],
  [74.01, 63.86],
  [88.85, 27.57],
  [11.15, 72.43],
  [25.99, 36.14],
];

const ICOSAHEDRON_EDGES: [number, number][] = [
  [0, 1], [0, 4], [0, 5], [0, 8], [0, 10],
  [1, 6], [1, 7], [1, 8], [1, 10],
  [2, 3], [2, 4], [2, 5], [2, 9], [2, 11],
  [3, 6], [3, 7], [3, 9], [3, 11],
  [4, 5], [4, 8], [4, 9],
  [5, 10], [5, 11],
  [6, 7], [6, 8], [6, 9],
  [7, 10], [7, 11],
  [8, 9],
  [10, 11],
];

/**
 * d4/d6 are plain geometric outlines — legible at icon size, no wireframe
 * needed. The d20's lines deliberately do NOT use
 * `vector-effect="non-scaling-stroke"` — that was tried and reverted: it
 * pins the stroke to a fixed *absolute* pixel width regardless of how far
 * the 100×100 viewBox gets squeezed down to icon size, so a "4"-unit stroke
 * rendered as a genuine 4 real pixels wide at a ~40px icon — nearly 10% of
 * the icon's width per line. With 30 edges converging through only 12
 * vertices at that width, the lines fused into filled, translucent-looking
 * blobs instead of reading as a wireframe. Letting the stroke scale down
 * naturally with the viewBox (like d4/d6 already do) keeps it a thin, crisp
 * line at any icon size; `strokeLinecap` is left at its default (butt) so
 * edges meet in sharp points at each vertex instead of piling into rounded
 * dots.
 */
function DieOutline({ shape }: { shape: DieShape }) {
  if (shape === "d4") return <polygon points="12,3 21,20 3,20" />;
  if (shape === "d6") return <rect x="4" y="4" width="16" height="16" rx="1.5" />;
  return (
    <g stroke="currentColor" strokeWidth="1.5" fill="none">
      {ICOSAHEDRON_EDGES.map(([a, b], i) => {
        const [x1, y1] = ICOSAHEDRON_VERTICES[a]!;
        const [x2, y2] = ICOSAHEDRON_VERTICES[b]!;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
    </g>
  );
}

/**
 * A die value — its shape outline with the actual rolled/kept number
 * layered in the middle. Used both for the base d20 roll (with `struck` for
 * the discarded half of an advantage/disadvantage pair) and for a dice
 * spell-effect term inline in the calculation.
 *
 * Sizing bumped up a notch from the previous round per feedback — this is
 * meant to read as a prominent result, not a small detail. The d4 triangle
 * isn't symmetric top-to-bottom (the apex eats space at the top), so its
 * visual middle sits below the box's geometric center — nudged the number
 * down (~incenter of the `12,3 21,20 3,20` triangle vs. the box's true
 * center) to land in the actual blank space instead of looking high.
 */
function DieValue({
  shape,
  value,
  struck = false,
  size = "h-8 w-8",
  textSize = "text-sm",
  tone = "text-parchment-dim/60",
  valueTone = "text-parchment",
}: {
  shape: DieShape;
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
        viewBox={DIE_VIEWBOX[shape]}
        className={`absolute inset-0 h-full w-full ${struck ? "text-parchment-dim/30" : tone}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <DieOutline shape={shape} />
      </svg>
      <span
        className={`relative z-10 font-mono font-bold ${textSize} ${shape === "d4" ? "translate-y-[10%]" : ""} ${
          struck ? "text-parchment-dim line-through" : valueTone
        }`}
      >
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
    <span className="flex items-center gap-1.5">
      {f.discardedRoll !== undefined ? (
        <DieValue shape="d20" value={f.discardedRoll} struck size="h-9 w-9" textSize="text-sm" />
      ) : null}
      <DieValue shape="d20" value={f.roll} size="h-11 w-11" textSize="text-base" />
    </span>
  );

  if (calc.kind === "nat1" || calc.kind === "nat20") {
    return (
      <span className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
        {rollTerm}
        <span
          className={`font-display text-lg font-bold uppercase tracking-widest ${
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
    <span className="flex flex-nowrap items-center gap-1.5 whitespace-nowrap font-mono text-base text-parchment-dim">
      {rollTerm}
      {operator} <ModifierValue value={Math.abs(calc.modifier)} />
      {diceEffects.map((e, i) => (
        <span key={i} className="flex items-center gap-1">
          + <DieValue shape={e.dieShape!} value={e.dieValue!} size="h-9 w-9" textSize="text-sm" tone="text-sky-300/60" valueTone="text-sky-100" />
        </span>
      ))}
      ={" "}
      <span className="flex h-10 w-10 items-center justify-center rounded-md border-2 border-gilt bg-tavern-panel-dark font-display text-base text-parchment">
        {total}
      </span>
    </span>
  );
}

/**
 * Is this spell effect good news or bad news for the roll it's attached to?
 * dice/advantage are always additive-only in the catalog (never a downside),
 * disadvantage always is; flat/multiplier/set don't carry their own sign in
 * a uniform way (e.g. "set to 0" reads as neutral text but is a bust for
 * anyone whose base modifier was positive), so those three compare the
 * fixture's actual before/after modifier instead of parsing `detail`.
 */
function isBoonEffect(e: SpellEffectFixture, f: Fixture): boolean {
  if (e.kind === "dice" || e.kind === "advantage") return true;
  if (e.kind === "disadvantage") return false;
  return f.finalModifier >= f.baseModifier;
}

/**
 * One caster-attributed badge per spell effect — name only, no icon (the
 * icon lives in the calc line for dice effects). The badge itself stays the
 * plain bordered pill it always was; it's the card-name text inside that
 * carries two combined animations (locked in after comparing options —
 * see git history on this branch for the jitter/other-motion demos that
 * were rejected in favour of this pairing):
 *   - a slow scrolling gradient (the `badge-scroll` keyframes below, via
 *     background-clip so the gradient paints the glyphs themselves rather
 *     than a background box) giving the boon/bust color — warm gold/amber
 *     for a boon, a "devilish" deep red for a bust;
 *   - a soft pulse/glow (`text-pulse-glow-boon`/`-bust`, tinted to match)
 *     layered on top, so the text reads as "magically charged" rather than
 *     inert even between gradient sweeps.
 */
function EffectBadges({ f }: { f: Fixture }) {
  if (!f.spellEffects || f.spellEffects.length === 0) return null;
  return (
    <>
      {f.spellEffects.map((e, i) => {
        const boon = isBoonEffect(e, f);
        return (
          <div key={i} className="flex items-center gap-1.5" title={e.detail}>
            <span
              className={`rounded-full border border-gilt-dark bg-tavern-panel-dark px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide [-webkit-background-clip:text] [background-clip:text] [background-size:200%_100%] text-transparent ${
                boon
                  ? "[background-image:linear-gradient(110deg,#f5c542,#fff2b8,#f5c542)]"
                  : "[background-image:linear-gradient(110deg,#7f1414,#e0433f,#7f1414)]"
              }`}
              style={{
                animation: `badge-scroll 2.5s ease-in-out infinite alternate, ${
                  boon ? "text-pulse-glow-boon" : "text-pulse-glow-bust"
                } 1.8s ease-in-out infinite`,
              }}
            >
              {e.cardName}
            </span>
            <span className="text-[10px] text-parchment-dim">{e.casterName}</span>
          </div>
        );
      })}
    </>
  );
}

export function RollCalculationVariants() {
  return (
    <>
      {/* Sweeps the gradient's background-position left, then back right
          (animation-direction: alternate on the utility below) rather than
          looping one-way — a one-way loop has to snap back to its start
          position every cycle, which reads as a jump-cut; ping-ponging
          means every frame is a continuous move in one direction or the
          other. background-size is 200% so there's room to sweep across. */}
      <style>{`
        @keyframes badge-scroll {
          to { background-position: -100% 0; }
        }
        /* Smooth (default ease, no steps()) pulse — chosen over a discrete
           "jitter" (wrong feel) and a breathing-scale/letter-wave
           alternative (git history on this branch has the rejected demo
           block). Tinted per boon/bust to match the gradient underneath. */
        @keyframes text-pulse-glow-boon {
          0%, 100% { opacity: 1; text-shadow: 0 0 0px rgba(245, 197, 66, 0); }
          50% { opacity: 0.85; text-shadow: 0 0 6px rgba(245, 197, 66, 0.85); }
        }
        @keyframes text-pulse-glow-bust {
          0%, 100% { opacity: 1; text-shadow: 0 0 0px rgba(224, 67, 63, 0); }
          50% { opacity: 0.85; text-shadow: 0 0 6px rgba(224, 67, 63, 0.85); }
        }
      `}</style>

      <CardFrame title="Roll Calculation UI — prototype (spell-affected rolls)">
        <ul className="divide-y divide-gilt-dark/40">
          {FIXTURES.map((f) => (
            <li key={f.label} className="flex items-center justify-between gap-4 py-3">
              <div className="flex flex-col">
                <span className="font-body text-base font-semibold text-parchment">{f.playerName}</span>
                <span className="text-[10px] text-parchment-dim/70">{f.label}</span>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <CalcLine f={f} />
                <EffectBadges f={f} />
              </div>
            </li>
          ))}
        </ul>
      </CardFrame>
    </>
  );
}
