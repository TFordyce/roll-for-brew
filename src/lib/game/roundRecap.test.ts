import { beforeEach, describe, expect, it } from "vitest";
import { buildRoundRecap, buildScrappedGenerationRecap } from "./roundRecap";
import type { RoundRecapCast, RoundRecapData, ScrappedGeneration } from "@/lib/supabase/roundRecap";
import type { CompletedLayer, ResolutionTraceStep } from "@/lib/supabase/rolls";

// --- fixture helpers ---------------------------------------------------

const NAMES: Record<string, string> = {
  ada: "Ada",
  ben: "Ben",
  cass: "Cass",
  dev: "Dev",
};
const displayName = (id: string) => NAMES[id] ?? id;

let seqCounter = 0;

function cast(overrides: Partial<RoundRecapCast> = {}): RoundRecapCast {
  seqCounter += 1;
  return {
    castId: `C${seqCounter}`,
    seq: seqCounter,
    cardName: "Lucky Sip",
    casterPlayerId: "cass",
    targetPlayerId: "cass",
    targetPending: false,
    effectKind: "flat_modifier",
    phase: "preroll",
    negated: false,
    redirectedToCastId: null,
    onStack: true,
    ...overrides,
  };
}

let stepIndex = 0;
function step(overrides: Partial<ResolutionTraceStep> = {}): ResolutionTraceStep {
  const idx = stepIndex++;
  return {
    index: idx,
    displayKind: "flat_modifier",
    sourceCast: {
      castId: `C${idx + 1}`,
      activeEffectId: null,
      cardName: "Lucky Sip",
      casterPlayerId: "cass",
    },
    targetPlayer: "cass",
    before: { type: "modifier", value: 2 },
    after: { type: "modifier", value: 5 },
    outcome: "applied",
    negated: false,
    backfire: false,
    contest: null,
    ward: null,
    restOfDay: false,
    pairOp: null,
    ...overrides,
  };
}

function data(over: Partial<RoundRecapData> = {}): RoundRecapData {
  return { resolved: true, layerZeroOutcome: "brewer", trace: [], casts: [], scrappedGenerations: [], ...over };
}

beforeEach(() => {
  seqCounter = 0;
  stepIndex = 0;
});

// --- tests -----------------------------------------------------------

describe("buildRoundRecap", () => {
  it("zero-cast round: no content, no chrome", () => {
    const model = buildRoundRecap({ data: data({ casts: [], trace: [] }), displayName });
    expect(model.hasContent).toBe(false);
    expect(model.castStrip).toEqual([]);
    expect(model.phases).toEqual([]);
    expect(model.showReorderCaption).toBe(false);
  });

  it("single-cast resolved round: one phase group, numbered step, cast strip", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [cast({ castId: "C1", cardName: "Lucky Sip", casterPlayerId: "cass", targetPlayerId: "ada" })],
        trace: [
          step({
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Lucky Sip", casterPlayerId: "cass" },
            targetPlayer: "ada",
            before: { type: "modifier", value: 2 },
            after: { type: "modifier", value: 5 },
          }),
        ],
      }),
      displayName,
    });

    expect(model.hasContent).toBe(true);
    expect(model.castStrip).toEqual([
      { castId: "C1", cardName: "Lucky Sip", casterName: "Cass", state: "applied" },
    ]);
    expect(model.phases).toHaveLength(1);
    expect(model.phases[0]!.label).toBe("Before the roll");
    const s = model.phases[0]!.steps[0]!;
    expect(s.displayIndex).toBe("1");
    expect(s.sentence).toBe("Cass played Lucky Sip on Ada");
    expect(s.beforeAfter).toEqual({ label: "mod", from: "2", to: "5", unchanged: false });
    expect(s.statusLabel).toBe("applied");
    expect(model.showReorderCaption).toBe(false);
  });

  it("zero-impact step is kept and flagged unchanged", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [cast({ castId: "C1" })],
        trace: [
          step({
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Fizzle", casterPlayerId: "cass" },
            before: { type: "modifier", value: 3 },
            after: { type: "modifier", value: 3 },
            outcome: "no-op",
          }),
        ],
      }),
      displayName,
    });
    const s = model.phases[0]!.steps[0]!;
    expect(s.beforeAfter).toEqual({ label: "mod", from: "3", to: "3", unchanged: true });
    expect(s.statusLabel).toBe("no effect");
    expect(model.castStrip[0]!.state).toBe("no-op");
  });

  it("7-cast round with reactions on reactions: phase grouping + resolution order preserved", () => {
    const casts: RoundRecapCast[] = [
      cast({ castId: "C1", cardName: "Steady Hand", casterPlayerId: "ada", targetPlayerId: "ada", phase: "preroll", effectKind: "flat_modifier" }),
      cast({ castId: "C2", cardName: "Bitter Brew", casterPlayerId: "ben", targetPlayerId: "cass", phase: "preroll", effectKind: "flat_modifier" }),
      cast({ castId: "C3", cardName: "Lucky Sip", casterPlayerId: "cass", targetPlayerId: "cass", phase: "preroll", effectKind: "advantage" }),
      cast({ castId: "C4", cardName: "Counterspell", casterPlayerId: "dev", targetPlayerId: "cass", phase: "reaction", effectKind: "contested_negate" }),
      cast({ castId: "C5", cardName: "Mirror", casterPlayerId: "ada", targetPlayerId: "dev", phase: "reaction", effectKind: "redirect" }),
      cast({ castId: "C6", cardName: "Broken Biscuit", casterPlayerId: "ben", targetPlayerId: "ben", phase: "reaction", effectKind: "lowest_gains_highest_modifier" }),
      cast({ castId: "C7", cardName: "Second Wind", casterPlayerId: "cass", targetPlayerId: "cass", phase: "reaction", effectKind: "flat_modifier" }),
    ];
    const trace: ResolutionTraceStep[] = [
      // reaction-phase cast-log resolution comes first in resolution order
      step({ displayKind: "contested_negate", sourceCast: { castId: "C4", activeEffectId: null, cardName: "Counterspell", casterPlayerId: "dev" }, targetPlayer: "cass", before: { type: "status", value: "cast" }, after: { type: "status", value: "negated target" }, contest: { d20: 14, dc: 5 } }),
      step({ displayKind: "redirect", sourceCast: { castId: "C5", activeEffectId: null, cardName: "Mirror", casterPlayerId: "ada" }, targetPlayer: "dev", before: { type: "target", value: "cass" }, after: { type: "target", value: "dev" } }),
      // preroll modifier composition
      step({ displayKind: "flat_modifier", sourceCast: { castId: "C1", activeEffectId: null, cardName: "Steady Hand", casterPlayerId: "ada" }, targetPlayer: "ada", before: { type: "modifier", value: 0 }, after: { type: "modifier", value: 2 } }),
      step({ displayKind: "flat_modifier", sourceCast: { castId: "C2", activeEffectId: null, cardName: "Bitter Brew", casterPlayerId: "ben" }, targetPlayer: "cass", before: { type: "modifier", value: 0 }, after: { type: "modifier", value: -3 } }),
      // reaction modifier
      step({ displayKind: "lowest_gains_highest_modifier", sourceCast: { castId: "C6", activeEffectId: null, cardName: "Broken Biscuit", casterPlayerId: "ben" }, targetPlayer: "ben", before: { type: "modifier", value: 2 }, after: { type: "modifier", value: 6 } }),
      step({ displayKind: "flat_modifier", sourceCast: { castId: "C7", activeEffectId: null, cardName: "Second Wind", casterPlayerId: "cass" }, targetPlayer: "cass", before: { type: "modifier", value: -3 }, after: { type: "modifier", value: -1 } }),
      // outcome
      step({ displayKind: "tea_maker_override", sourceCast: { castId: null, activeEffectId: null, cardName: "Barista's Call", casterPlayerId: "dev" }, targetPlayer: "ada", before: { type: "status", value: "pending" }, after: { type: "status", value: "brewer" } }),
    ];

    const model = buildRoundRecap({ data: data({ casts, trace }), displayName });

    // Phase headers follow resolution order, inserted on every phase change —
    // so "Reaction window" recurs after the pre-roll modifiers (Broken Biscuit
    // / Second Wind resolve back in the reaction window).
    expect(model.phases.map((p) => p.label)).toEqual([
      "Reaction window",
      "Before the roll",
      "Reaction window",
      "Outcome",
    ]);
    expect(model.phases.map((p) => p.steps.map((s) => s.displayKind))).toEqual([
      ["contested_negate", "redirect"],
      ["flat_modifier", "flat_modifier"],
      ["lowest_gains_highest_modifier", "flat_modifier"],
      ["tea_maker_override"],
    ]);
    // numbered 1..7 in resolution (Trace) order, never re-sorted into buckets
    expect(model.phases.flatMap((p) => p.steps).map((s) => s.displayIndex)).toEqual([
      "1", "2", "3", "4", "5", "6", "7",
    ]);
    expect(model.castStrip).toHaveLength(7);
    expect(model.showReorderCaption).toBe(true);
    // every caster can find their own cast
    expect(new Set(model.castStrip.map((c) => c.casterName))).toEqual(
      new Set(["Ada", "Ben", "Cass", "Dev"]),
    );
  });

  it("negated cast: strip state negated, victim step reads 'was negated'", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [
          cast({ castId: "C1", cardName: "Bitter Brew", casterPlayerId: "ben", targetPlayerId: "ada", negated: true, effectKind: "flat_modifier" }),
          cast({ castId: "C2", cardName: "Counterspell", casterPlayerId: "dev", targetPlayerId: "ada", phase: "reaction", effectKind: "contested_negate" }),
        ],
        trace: [
          step({ displayKind: "contested_negate", sourceCast: { castId: "C2", activeEffectId: null, cardName: "Counterspell", casterPlayerId: "dev" }, targetPlayer: "ada", before: { type: "status", value: "cast" }, after: { type: "status", value: "negated target" }, contest: { d20: 18, dc: 2 } }),
          step({ displayKind: "flat_modifier", sourceCast: { castId: null, activeEffectId: null, cardName: "Bitter Brew", casterPlayerId: "ben" }, targetPlayer: "ada", before: { type: "status", value: "negated" }, after: { type: "status", value: "negated" }, negated: true }),
        ],
      }),
      displayName,
    });

    const stripByCard = Object.fromEntries(model.castStrip.map((c) => [c.cardName, c.state]));
    expect(stripByCard["Bitter Brew"]).toBe("negated");
    expect(stripByCard["Counterspell"]).toBe("applied");

    const sentences = model.phases.flatMap((p) => p.steps).map((s) => s.sentence);
    expect(sentences).toContain("Dev played Counterspell to counter Ada's effect (rolled 18 vs DC 2)");
    expect(sentences).toContain("Ada's flat modifier was negated");
  });

  it("redirected cast: strip state redirected, redirect sentence names the new target", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [
          cast({ castId: "C1", cardName: "Scalding Pour", casterPlayerId: "ben", targetPlayerId: "ada", redirectedToCastId: "C2", effectKind: "flat_modifier" }),
          cast({ castId: "C2", cardName: "Mirror", casterPlayerId: "ada", targetPlayerId: "ben", phase: "reaction", effectKind: "redirect" }),
        ],
        trace: [
          step({ displayKind: "redirect", sourceCast: { castId: "C2", activeEffectId: null, cardName: "Mirror", casterPlayerId: "ada" }, targetPlayer: "ben", before: { type: "target", value: "ada" }, after: { type: "target", value: "ben" } }),
        ],
      }),
      displayName,
    });
    const stripByCard = Object.fromEntries(model.castStrip.map((c) => [c.cardName, c.state]));
    expect(stripByCard["Scalding Pour"]).toBe("redirected");
    expect(model.phases.flatMap((p) => p.steps).map((s) => s.sentence)).toContain(
      "Ada played Mirror — the effect is redirected to Ben",
    );
  });

  it("backfired counter: strip state backfired, step re-applied onto its own caster", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [
          cast({ castId: "C1", cardName: "Bitter Brew", casterPlayerId: "ben", targetPlayerId: "ada", effectKind: "flat_modifier" }),
          cast({ castId: "C2", cardName: "Counterspell", casterPlayerId: "dev", targetPlayerId: "ada", phase: "reaction", effectKind: "contested_negate" }),
        ],
        trace: [
          step({ displayKind: "contested_negate", sourceCast: { castId: "C2", activeEffectId: null, cardName: "Counterspell", casterPlayerId: "dev" }, targetPlayer: "ada", before: { type: "status", value: "cast" }, after: { type: "status", value: "backfired" }, outcome: "backfired", contest: { d20: 1, dc: 5 } }),
          step({ displayKind: "flat_modifier", sourceCast: { castId: "C2", activeEffectId: null, cardName: "Bitter Brew", casterPlayerId: "ben" }, targetPlayer: "dev", before: { type: "modifier", value: 0 }, after: { type: "modifier", value: -3 }, backfire: true }),
        ],
      }),
      displayName,
    });
    const stripByCard = Object.fromEntries(model.castStrip.map((c) => [c.cardName, c.state]));
    expect(stripByCard["Counterspell"]).toBe("backfired");
    const contestStep = model.phases.flatMap((p) => p.steps).find((s) => s.displayKind === "contested_negate")!;
    expect(contestStep.statusLabel).toBe("backfired");
  });

  it("blocked by a ward: strip state blocked, ward sentence names both cards", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [
          cast({ castId: "C1", cardName: "Scalding Pour", casterPlayerId: "ben", targetPlayerId: "ada", effectKind: "flat_modifier" }),
        ],
        trace: [
          step({
            displayKind: "warded",
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Scalding Pour", casterPlayerId: "ben" },
            targetPlayer: "ada",
            before: { type: "modifier", value: 4 },
            after: { type: "modifier", value: 4 },
            outcome: "blocked",
            ward: { wardCastId: "W9", wardCardName: "Cloak of Milk" },
          }),
        ],
      }),
      displayName,
    });
    expect(model.castStrip[0]!.state).toBe("blocked");
    const s = model.phases[0]!.steps[0]!;
    expect(s.sentence).toBe("Cloak of Milk wards Ada — Scalding Pour is blocked");
    expect(s.statusLabel).toBe("blocked");
  });

  it("live round: pending steps in cast order, index '·', no numbers, no caption", () => {
    const casts: RoundRecapCast[] = [
      cast({ castId: "C1", cardName: "Steady Hand", casterPlayerId: "ada", targetPlayerId: "ada", phase: "preroll", onStack: true }),
      cast({ castId: "C2", cardName: "Counterspell", casterPlayerId: "dev", targetPlayerId: "cass", phase: "reaction", onStack: true }),
      cast({ castId: "C3", cardName: "Late Arm", casterPlayerId: "ben", targetPlayerId: null, phase: "preroll", onStack: false }),
    ];
    const model = buildRoundRecap({ data: data({ resolved: false, casts, trace: [] }), displayName });

    expect(model.hasContent).toBe(true);
    expect(model.showReorderCaption).toBe(false);
    const steps = model.phases.flatMap((p) => p.steps);
    expect(steps.every((s) => s.pending && s.displayIndex === "·" && s.beforeAfter === null)).toBe(true);
    // Cast order (by seq) is preserved across phases — a reaction cast armed
    // before a later pre-roll cast still renders before it.
    expect(steps.map((s) => s.sentence)).toEqual([
      "Ada played Steady Hand on Ada",
      "Dev played Counterspell on Cass",
      "Ben played Late Arm",
    ]);
    expect(model.phases.map((p) => p.label)).toEqual([
      "Before the roll",
      "Reaction window",
      "Before the roll",
    ]);
    expect(model.castStrip.map((c) => c.state)).toEqual(["on-stack", "on-stack", "armed"]);
  });

  it("pending → resolved: same casts re-sort from cast order to resolution order", () => {
    const casts: RoundRecapCast[] = [
      cast({ castId: "C1", cardName: "Slow Pour", casterPlayerId: "ada", targetPlayerId: "ada", phase: "preroll", effectKind: "flat_modifier" }),
      cast({ castId: "C2", cardName: "Counterspell", casterPlayerId: "dev", targetPlayerId: "ada", phase: "reaction", effectKind: "contested_negate" }),
    ];

    const liveModel = buildRoundRecap({ data: data({ resolved: false, casts, trace: [] }), displayName });
    expect(liveModel.phases.flatMap((p) => p.steps).map((s) => s.castId)).toEqual(["C1", "C2"]);

    // Resolution order puts the reaction-phase counter first.
    const trace: ResolutionTraceStep[] = [
      step({ displayKind: "contested_negate", sourceCast: { castId: "C2", activeEffectId: null, cardName: "Counterspell", casterPlayerId: "dev" }, targetPlayer: "ada", before: { type: "status", value: "cast" }, after: { type: "status", value: "no effect" }, outcome: "no-op" }),
      step({ displayKind: "flat_modifier", sourceCast: { castId: "C1", activeEffectId: null, cardName: "Slow Pour", casterPlayerId: "ada" }, targetPlayer: "ada", before: { type: "modifier", value: 1 }, after: { type: "modifier", value: 3 } }),
    ];
    const resolvedModel = buildRoundRecap({ data: data({ resolved: true, casts, trace }), displayName });
    // Resolution order runs the reaction-phase counter first, then the
    // pre-roll modifier — the step list and its numbering follow the Trace,
    // and the phase header flips with it.
    expect(resolvedModel.phases.map((p) => p.label)).toEqual(["Reaction window", "Before the roll"]);
    expect(resolvedModel.phases.flatMap((p) => p.steps).map((s) => s.castId)).toEqual(["C2", "C1"]);
    expect(resolvedModel.phases.flatMap((p) => p.steps).map((s) => s.displayIndex)).toEqual(["1", "2"]);
    expect(resolvedModel.showReorderCaption).toBe(true);
  });

  it("went to tie-break: endedInTieBreak set, steps still render, no Outcome group", () => {
    const model = buildRoundRecap({
      data: data({
        layerZeroOutcome: "tie",
        casts: [cast({ castId: "C1", cardName: "Steady Hand", casterPlayerId: "ada", targetPlayerId: "ada", effectKind: "flat_modifier" })],
        trace: [
          step({ displayKind: "flat_modifier", sourceCast: { castId: "C1", activeEffectId: null, cardName: "Steady Hand", casterPlayerId: "ada" }, targetPlayer: "ada", before: { type: "modifier", value: 0 }, after: { type: "modifier", value: 2 } }),
        ],
      }),
      displayName,
    });
    expect(model.endedInTieBreak).toBe(true);
    expect(model.phases.map((p) => p.label)).toEqual(["Before the roll"]);
    expect(model.phases.flatMap((p) => p.steps)).toHaveLength(1);
  });

  it("traceOnly: renders trace steps with no cast list, empty cast strip", () => {
    const trace: ResolutionTraceStep[] = [
      step({
        displayKind: "flat_modifier",
        sourceCast: { castId: "C1", activeEffectId: null, cardName: "Lucky Sip", casterPlayerId: "cass" },
        targetPlayer: "ada",
        before: { type: "modifier", value: 1 },
        after: { type: "modifier", value: 4 },
      }),
    ];
    // Without the flag, a cast-less resolved round is "no content".
    expect(buildRoundRecap({ data: data({ casts: [], trace }), displayName }).hasContent).toBe(false);
    // With it, the step rows render and the strip is simply absent.
    const model = buildRoundRecap({ data: data({ casts: [], trace }), displayName, traceOnly: true });
    expect(model.hasContent).toBe(true);
    expect(model.castStrip).toEqual([]);
    expect(model.showReorderCaption).toBe(false);
    expect(model.phases.flatMap((p) => p.steps).map((s) => s.sentence)).toEqual(["Cass played Lucky Sip on Ada"]);
  });

  it("traceOnly with an empty trace stays no-content", () => {
    expect(buildRoundRecap({ data: data({ casts: [], trace: [] }), displayName, traceOnly: true }).hasContent).toBe(
      false,
    );
  });
});

// --- buildScrappedGenerationRecap (issue #352) ------------------------

function layer(over: Partial<CompletedLayer> & { layer: number }): CompletedLayer {
  return {
    rolls: [
      { playerId: "ada", value: 10, modifierSnapshot: 2, discardedValue: null, enteredByAdmin: false },
      { playerId: "ben", value: 12, modifierSnapshot: 0, discardedValue: null, enteredByAdmin: false },
    ],
    ...over,
  };
}

function scrappedGen(over: Partial<ScrappedGeneration> = {}): ScrappedGeneration {
  return {
    generation: 0,
    brewerId: "ada",
    cupsMade: 3,
    brewerModifierGain: 3,
    resolvedAt: "2026-09-02T10:00:00Z",
    trace: [],
    layers: [layer({ layer: 0 })],
    layerParticipants: [
      { layer: 0, playerId: "ada" },
      { layer: 0, playerId: "ben" },
    ],
    ...over,
  };
}

describe("buildScrappedGenerationRecap", () => {
  it("carries the generation's headline fields through", () => {
    const model = buildScrappedGenerationRecap(scrappedGen(), displayName);
    expect(model.generation).toBe(0);
    expect(model.brewerId).toBe("ada");
    expect(model.cupsMade).toBe(3);
    expect(model.brewerModifierGain).toBe(3);
  });

  it("builds the Recap from the generation's Trace alone, no cast strip", () => {
    const model = buildScrappedGenerationRecap(
      scrappedGen({
        trace: [
          step({
            displayKind: "flat_modifier",
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Lucky Sip", casterPlayerId: "cass" },
            targetPlayer: "ada",
            before: { type: "modifier", value: 0 },
            after: { type: "modifier", value: 2 },
          }),
        ],
      }),
      displayName,
    );
    expect(model.recap.hasContent).toBe(true);
    expect(model.recap.castStrip).toEqual([]);
    expect(model.recap.phases.flatMap((p) => p.steps)).toHaveLength(1);
  });

  it("layer-0 only: not a tie-break, every first-attempt row has an empty reroll chain", () => {
    const model = buildScrappedGenerationRecap(scrappedGen(), displayName, ["ada", "ben"]);
    expect(model.wentToTieBreak).toBe(false);
    expect(model.recap.endedInTieBreak).toBe(false);
    expect(model.firstAttemptRolls.map((r) => r.playerId)).toEqual(["ada", "ben"]);
    expect(model.firstAttemptRolls.every((r) => r.rerollChain.length === 0)).toBe(true);
  });

  it("went to a tie-break: wentToTieBreak + endedInTieBreak, reroll chain on each row", () => {
    const model = buildScrappedGenerationRecap(
      scrappedGen({
        layers: [layer({ layer: 0 }), layer({ layer: 1 })],
        layerParticipants: [
          { layer: 0, playerId: "ada" },
          { layer: 0, playerId: "ben" },
          { layer: 1, playerId: "ada" },
          { layer: 1, playerId: "ben" },
        ],
        trace: [
          step({
            displayKind: "flat_modifier",
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Lucky Sip", casterPlayerId: "cass" },
            targetPlayer: "ada",
            before: { type: "modifier", value: 0 },
            after: { type: "modifier", value: 2 },
          }),
        ],
      }),
      displayName,
      ["ada", "ben"],
    );
    expect(model.wentToTieBreak).toBe(true);
    expect(model.recap.endedInTieBreak).toBe(true);
    // ada 10+2 ties ben 12+0 at layer 0, and again at layer 1 (same fixture),
    // so each row carries one reroll level, still tied.
    expect(model.firstAttemptRolls.map((r) => r.rerollChain.map((c) => c.layer))).toEqual([[1], [1]]);
  });

  it("tie-break with no casts that generation: wentToTieBreak still set, recap empty", () => {
    const model = buildScrappedGenerationRecap(
      scrappedGen({ layers: [layer({ layer: 0 }), layer({ layer: 1 })], trace: [] }),
      displayName,
      ["ada", "ben"],
    );
    expect(model.wentToTieBreak).toBe(true);
    expect(model.recap.hasContent).toBe(false);
    expect(model.firstAttemptRolls).toHaveLength(2);
  });

  it("empty Trace (no casts that generation): recap has no content, headline still there", () => {
    const model = buildScrappedGenerationRecap(scrappedGen({ trace: [] }), displayName);
    expect(model.recap.hasContent).toBe(false);
    expect(model.brewerId).toBe("ada");
  });

  it("orders first-attempt rolls: roster first, gen-0-only roller in snapshot order after", () => {
    const model = buildScrappedGenerationRecap(
      scrappedGen({
        layers: [
          layer({
            layer: 0,
            rolls: [
              { playerId: "ben", value: 8, modifierSnapshot: 0, discardedValue: null, enteredByAdmin: false },
              { playerId: "ada", value: 10, modifierSnapshot: 2, discardedValue: null, enteredByAdmin: false },
              { playerId: "cass", value: 15, modifierSnapshot: 1, discardedValue: null, enteredByAdmin: true },
            ],
          }),
        ],
        layerParticipants: [
          { layer: 0, playerId: "ada" },
          { layer: 0, playerId: "ben" },
          { layer: 0, playerId: "cass" },
        ],
      }),
      displayName,
      ["ada", "ben"], // cass late-declared in gen 0 only
    );
    expect(model.firstAttemptRolls.map((r) => r.playerId)).toEqual(["ada", "ben", "cass"]);
    expect(model.firstAttemptRolls[2]!.enteredByAdmin).toBe(true);
  });
});
