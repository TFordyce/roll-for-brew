import { beforeEach, describe, expect, it } from "vitest";
import { buildRerollChain, buildRoundRecap, buildScrappedGenerationRecap } from "./roundRecap";
import type {
  ResolutionSummaryEntry,
  RoundRecapCast,
  RoundRecapData,
  ScrappedGeneration,
} from "@/lib/supabase/roundRecap";
import {
  parseResolutionTrace,
  type CompletedLayer,
  type ForfeitReason,
  type ImmunityTier,
  type ResolutionTraceStep,
} from "@/lib/supabase/rolls";

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
    compelledByCastId: null,
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
    condition: null,
    diceTick: null,
    compel: null,
    heistReason: null,
    overrideReason: null,
    failedOverrideCondition: null,
    immunity: null,
    pickedBy: null,
    earlTransfer: null,
    rolloffOpponents: [],
    ...overrides,
  };
}

function data(over: Partial<RoundRecapData> = {}): RoundRecapData {
  return {
    resolved: true,
    layerZeroOutcome: "brewer",
    trace: [],
    casts: [],
    scrappedGenerations: [],
    layers: [],
    layerParticipants: [],
    reactionSkips: [],
    summary: null,
    provisional: false,
    ...over,
  };
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

  it("conditional advantage (Gambler's Infusion): a met threshold renders as a plain advantage step", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [cast({ castId: "C1", cardName: "Gambler's Infusion", casterPlayerId: "ada", targetPlayerId: "ada", effectKind: "advantage" })],
        trace: [
          step({
            displayKind: "advantage",
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Gambler's Infusion", casterPlayerId: "ada" },
            targetPlayer: "ada",
            before: { type: "roll", value: 17 },
            after: { type: "roll", value: 19 },
            outcome: "applied",
            condition: { firstDie: 17, branch: "advantage", advantageAtOrAbove: 15, disadvantageAtOrBelow: 5 },
          }),
        ],
      }),
      displayName,
    });
    const s = model.phases.flatMap((p) => p.steps)[0]!;
    expect(s.sentence).toBe("Ada played Gambler's Infusion — Ada rolls with advantage");
    expect(s.beforeAfter).toEqual({ label: "roll", from: "17", to: "19", unchanged: false });
  });

  it("conditional advantage (Gambler's Infusion): neither threshold met is a kept zero-impact step", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [cast({ castId: "C1", cardName: "Gambler's Infusion", casterPlayerId: "ada", targetPlayerId: "ada", effectKind: "advantage" })],
        trace: [
          step({
            displayKind: "conditional_advantage",
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Gambler's Infusion", casterPlayerId: "ada" },
            targetPlayer: "ada",
            before: { type: "roll", value: 9 },
            after: { type: "roll", value: 9 },
            outcome: "no-op",
            condition: { firstDie: 9, branch: "none", advantageAtOrAbove: 15, disadvantageAtOrBelow: 5 },
          }),
        ],
      }),
      displayName,
    });
    const s = model.phases.flatMap((p) => p.steps)[0]!;
    expect(s.sentence).toBe("Ada played Gambler's Infusion — Ada's first die was 9; neither threshold met, the roll stands");
    expect(s.beforeAfter).toEqual({ label: "roll", from: "9", to: "9", unchanged: true });
    expect(s.statusLabel).toBe("no effect");
  });

  it("targeting skip (Cloud of Cream): a status→status step in the Outcome phase naming the skipped holder", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [cast({ castId: "C1", cardName: "Broken Biscuit", casterPlayerId: "ben", targetPlayerId: null, effectKind: "lowest_gains_highest_modifier", phase: "reaction" })],
        trace: [
          step({
            displayKind: "targeting_skip",
            sourceCast: { castId: null, activeEffectId: "AE1", cardName: "Cloud of Cream", casterPlayerId: "ada" },
            targetPlayer: "ada",
            before: { type: "status", value: "targetable" },
            after: { type: "status", value: "skipped" },
            outcome: "applied",
          }),
          step({
            displayKind: "lowest_gains_highest_modifier",
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Broken Biscuit", casterPlayerId: "ben" },
            targetPlayer: "ben",
            before: { type: "modifier", value: 0 },
            after: { type: "modifier", value: 4 },
          }),
        ],
      }),
      displayName,
    });
    const s = model.phases.flatMap((p) => p.steps)[0]!;
    expect(s.displayKind).toBe("targeting_skip");
    expect(s.sentence).toBe("Cloud of Cream — Ada is skipped for highest/lowest-modifier targeting");
    expect(model.phases.find((p) => p.label === "Outcome")?.steps.some((x) => x.displayKind === "targeting_skip")).toBe(true);
  });

  describe("brewer immunity (issue #428)", () => {
    function immunityStep(tier: ImmunityTier, skippedCardName: string | null = null) {
      return step({
        displayKind: "brewer_immunity",
        sourceCast: { castId: null, activeEffectId: "AE1", cardName: "The Last Cuppa", casterPlayerId: "ada" },
        targetPlayer: "ada",
        before: { type: "status", value: "brewer" },
        after: { type: "status", value: "immune" },
        outcome: "applied",
        immunity: { tier, skippedCardName },
      });
    }
    // A cast-less round renders no steps (buildRoundRecap's empty exit), so
    // each fixture carries the round's Last Cuppa cast.
    const only = (trace: ResolutionTraceStep[]) => {
      const casts = [cast({ castId: "C0", cardName: "The Last Cuppa", casterPlayerId: "ada", effectKind: "brewer_immunity" })];
      const model = buildRoundRecap({ data: data({ casts, trace }), displayName });
      return { model, s: model.phases.flatMap((p) => p.steps)[0]! };
    };

    it("a declared-number match passes over the immune roller, in the Outcome group", () => {
      const { model, s } = only([immunityStep("declared_number", "Inscribed Saucer")]);
      expect(s.sentence).toBe("The Last Cuppa — Ada rolled the number declared by Inscribed Saucer but can't be Tea Maker");
      expect(s.statusLabel).toBe("applied");
      expect(model.phases.find((p) => p.label === "Outcome")?.steps).toHaveLength(1);
    });

    it("an override naming the immune player falls through", () => {
      expect(only([immunityStep("tea_maker_override", "Drip Tray")]).s.sentence).toBe(
        "The Last Cuppa — Drip Tray can't make Ada brew",
      );
    });

    it("the lowest roller is passed over for the next-lowest", () => {
      expect(only([immunityStep("lowest_roller")]).s.sentence).toBe(
        "The Last Cuppa — Ada rolled lowest but can't be Tea Maker; the next-lowest roll brews",
      );
    });

    it("everyone immune: immunity gives way to a Tie-Break Reroll", () => {
      const { s } = only([
        step({
          displayKind: "brewer_immunity",
          sourceCast: { castId: null, activeEffectId: null, cardName: null, casterPlayerId: null },
          targetPlayer: null,
          before: { type: "status", value: "immune" },
          after: { type: "status", value: "tie" },
          outcome: "applied",
          immunity: { tier: "all_immune", skippedCardName: null },
        }),
      ]);
      expect(s.sentence).toBe("Every Participant is immune — immunity gives way to a Tie-Break Reroll");
    });

    it("reads immunity_tier and skipped_card_name off the raw Trace step", () => {
      const [parsed] = parseResolutionTrace([
        {
          index: 0,
          display_kind: "brewer_immunity",
          source_cast: { cast_id: null, active_effect_id: "AE1", card_name: "The Last Cuppa", caster_player_id: "ada" },
          target_player: "ada",
          before: { type: "status", value: "brewer" },
          after: { type: "status", value: "immune" },
          outcome: "applied",
          immunity_tier: "tea_maker_override",
          skipped_card_name: "Drip Tray",
        },
      ]);
      expect(parsed!.immunity).toEqual({ tier: "tea_maker_override", skippedCardName: "Drip Tray" });
      expect(parseResolutionTrace([{ ...step(), display_kind: "flat_modifier" }])[0]!.immunity).toBeNull();
    });
  });

  describe("Earl of Earl Grey title transfer (issue #429)", () => {
    const transfer = (forcingCardName: string | null) =>
      step({
        displayKind: "earl_transfer",
        sourceCast: { castId: null, activeEffectId: "AE1", cardName: "Earl of Earl Grey", casterPlayerId: "ada" },
        targetPlayer: "ada",
        before: { type: "status", value: "earl" },
        after: { type: "status", value: "title passed" },
        outcome: "applied",
        earlTransfer: { newEarlPlayerId: "ben", forcingCardName },
      });
    const render = (trace: ResolutionTraceStep[]) => {
      const casts = [cast({ castId: "C0", cardName: "Drip Tray", casterPlayerId: "ben", effectKind: "tea_maker_override" })];
      return buildRoundRecap({ data: data({ casts, trace }), displayName });
    };

    it("says the force passes the title to its caster, in the Outcome group", () => {
      const model = render([transfer("Drip Tray")]);
      const [s] = model.phases.flatMap((p) => p.steps);
      expect(s!.sentence).toBe("Earl of Earl Grey — Drip Tray forces tea on Ada, so the Earl title passes to Ben");
      expect(model.phases.find((p) => p.label === "Outcome")?.steps).toHaveLength(1);
    });

    it("falls back when the forcing card is unnamed", () => {
      const [s] = render([transfer(null)]).phases.flatMap((p) => p.steps);
      expect(s!.sentence).toBe("Earl of Earl Grey — a card forces tea on Ada, so the Earl title passes to Ben");
    });

    it("reads new_earl_player_id and forcing_card_name off the raw Trace step", () => {
      const [parsed] = parseResolutionTrace([
        {
          index: 0,
          display_kind: "earl_transfer",
          source_cast: { cast_id: null, active_effect_id: "AE1", card_name: "Earl of Earl Grey", caster_player_id: "ada" },
          target_player: "ada",
          before: { type: "status", value: "earl" },
          after: { type: "status", value: "title passed" },
          outcome: "applied",
          new_earl_player_id: "ben",
          forcing_card_name: "Drip Tray",
        },
      ]);
      expect(parsed!.earlTransfer).toEqual({ newEarlPlayerId: "ben", forcingCardName: "Drip Tray" });
      expect(parseResolutionTrace([{ ...step(), display_kind: "flat_modifier" }])[0]!.earlTransfer).toBeNull();
    });
  });

  describe("Loose Leaf roll-off (issue #431)", () => {
    const rolloff = (over: Partial<ResolutionTraceStep> = {}) =>
      step({
        displayKind: "named_tea_maker_rolloff",
        sourceCast: { castId: "C0", activeEffectId: null, cardName: "Loose Leaf", casterPlayerId: "ada" },
        targetPlayer: "ada",
        before: { type: "status", value: "brewer" },
        after: { type: "status", value: "rolloff" },
        outcome: "applied",
        rolloffOpponents: ["ben"],
        ...over,
      });
    const render = (trace: ResolutionTraceStep[], over: Partial<RoundRecapData> = {}) => {
      const casts = [cast({ castId: "C0", cardName: "Loose Leaf", casterPlayerId: "ada", targetPlayerId: "ada", effectKind: "named_tea_maker_rolloff" })];
      return buildRoundRecap({ data: data({ casts, trace, ...over }), displayName });
    };

    it("says the named holder rolls off against the second-lowest roller, in the Outcome group", () => {
      const model = render([rolloff()]);
      const [s] = model.phases.flatMap((p) => p.steps);
      expect(s!.sentence).toBe("Ada played Loose Leaf — Ada is named Tea Maker, so Ada and Ben roll off; the lower roll brews");
      expect(model.phases.find((p) => p.label === "Outcome")?.steps).toHaveLength(1);
    });

    it("names every roller tied at second-lowest when they all roll off", () => {
      const [s] = render([rolloff({ rolloffOpponents: ["ben", "cass"] })]).phases.flatMap((p) => p.steps);
      expect(s!.sentence).toBe(
        "Ada played Loose Leaf — Ada is named Tea Maker, so Ada, Ben and Cass roll off; the lowest roll brews",
      );
    });

    it("says it did nothing when there's no distinct second-lowest roller", () => {
      const [s] = render([
        rolloff({ outcome: "no-op", after: { type: "status", value: "no effect" }, rolloffOpponents: [] }),
      ]).phases.flatMap((p) => p.steps);
      expect(s!.sentence).toBe("Ada played Loose Leaf — no effect: there's no second-lowest roller to roll off against");
    });

    it("a roll-off decided at a later Layer isn't reported as a tie for lowest", () => {
      expect(render([rolloff()], { layerZeroOutcome: "tie" }).endedInTieBreak).toBe(false);
      expect(
        render([rolloff({ outcome: "no-op", after: { type: "status", value: "no effect" }, rolloffOpponents: [] })], {
          layerZeroOutcome: "tie",
        }).endedInTieBreak,
      ).toBe(true);
    });

    it("reads rolloff_opponent_ids off the raw Trace step", () => {
      const [parsed] = parseResolutionTrace([
        {
          index: 0,
          display_kind: "named_tea_maker_rolloff",
          source_cast: { cast_id: "C0", active_effect_id: null, card_name: "Loose Leaf", caster_player_id: "ada" },
          target_player: "ada",
          before: { type: "status", value: "brewer" },
          after: { type: "status", value: "rolloff" },
          outcome: "applied",
          rolloff_opponent_ids: ["ben", "cass"],
        },
      ]);
      expect(parsed!.rolloffOpponents).toEqual(["ben", "cass"]);
      expect(parseResolutionTrace([{ ...step(), display_kind: "flat_modifier" }])[0]!.rolloffOpponents).toEqual([]);
    });
  });

  describe("Brew IOU / Brew Debt (issue #432)", () => {
    const debt = (after: "owes" | "brewer") =>
      step({
        displayKind: "brew_debt",
        sourceCast: { castId: "C0", activeEffectId: null, cardName: "Brew IOU", casterPlayerId: "ada" },
        targetPlayer: "ada",
        before: { type: "status", value: after === "owes" ? "clear" : "owes" },
        after: { type: "status", value: after },
        outcome: "applied",
      });
    it("says the caster now owes a Brew Debt, in the Outcome group", () => {
      const casts = [cast({ castId: "C0", cardName: "Brew IOU", casterPlayerId: "ada", targetPlayerId: "ben", effectKind: "tea_maker_override" })];
      const model = buildRoundRecap({ data: data({ casts, trace: [debt("owes")] }), displayName });
      const [s] = model.phases.flatMap((p) => p.steps);
      expect(s!.sentence).toBe("Brew IOU — Ada owes a Brew Debt: they make tea in their next round, no roll");
      expect(model.phases.find((p) => p.label === "Outcome")?.steps).toHaveLength(1);
    });

    it("says the Debtor pays the debt -- a debt round has no casts, only that step", () => {
      const model = buildRoundRecap({ data: data({ trace: [debt("brewer")] }), displayName });
      expect(model.hasContent).toBe(true);
      const [s] = model.phases.flatMap((p) => p.steps);
      expect(s!.sentence).toBe("Brew IOU — Ada pays their Brew Debt and makes tea; nobody rolls");
    });

    it("a round with no casts and no Brew Debt step still has no Recap content", () => {
      expect(buildRoundRecap({ data: data({ trace: [step()] }), displayName }).hasContent).toBe(false);
    });
  });

  describe("Roll Exemption (issue #433)", () => {
    const skip = step({
      displayKind: "roll_exemption",
      sourceCast: { castId: "C0", activeEffectId: null, cardName: "Loaf of Lipton", casterPlayerId: "ada" },
      targetPlayer: "ada",
      before: { type: "status", value: "rolls" },
      after: { type: "status", value: "skipped" },
      outcome: "applied",
    });
    const casts = [cast({ castId: "C0", cardName: "Loaf of Lipton", casterPlayerId: "ada", targetPlayerId: "ada", effectKind: "tea_maker_override" })];

    it("says the player skipped their roll, naming the card, before the roll", () => {
      const model = buildRoundRecap({ data: data({ casts, trace: [skip] }), displayName });
      const phase = model.phases.find((p) => p.label === "Before the roll");
      const [s] = phase!.steps;
      expect(s!.sentence).toBe("Ada skipped their roll — Loaf of Lipton");
      expect(s).toMatchObject({ statusLabel: "skipped", statusKind: "applied" });
    });
  });

  describe("Tea Heist (issue #438)", () => {
    function heist(after: string, over: Partial<ResolutionTraceStep> = {}) {
      return buildRoundRecap({
        data: data({
          casts: [cast({ castId: "C1", cardName: "Tea Heist", casterPlayerId: "ada", targetPlayerId: "ben", effectKind: "card_heist" })],
          trace: [
            step({
              displayKind: "card_heist",
              sourceCast: { castId: "C1", activeEffectId: null, cardName: "Tea Heist", casterPlayerId: "ada" },
              targetPlayer: "ben",
              before: { type: "status", value: "held" },
              after: { type: "status", value: after },
              outcome: after === "moved" ? "applied" : "no-op",
              ...over,
            }),
          ],
        }),
        displayName,
      });
    }
    const only = (model: ReturnType<typeof buildRoundRecap>) => model.phases.flatMap((p) => p.steps)[0]!;

    it("moved: the thief steals the victim's card, in the Outcome group", () => {
      const model = heist("moved");
      const s = only(model);
      expect(s.sentence).toBe("Ada played Tea Heist — Ada steals Ben's card");
      expect(s.statusLabel).toBe("moved");
      expect(s.statusKind).toBe("applied");
      expect(s.beforeAfter).toBeNull();
      expect(model.phases.find((p) => p.label === "Outcome")?.steps).toHaveLength(1);
    });

    it("fizzled: the victim played the card first", () => {
      const s = only(heist("fizzled", { heistReason: "victim_played_first" }));
      expect(s.sentence).toBe("Ada played Tea Heist on Ben — fizzled: Ben played the card first");
      expect(s.statusLabel).toBe("fizzled");
      expect(s.statusKind).toBe("no-op");
    });

    it("fizzled: the thief's hand is full", () => {
      expect(only(heist("fizzled", { heistReason: "thief_hand_full" })).sentence).toBe(
        "Ada played Tea Heist on Ben — fizzled: Ada's hand is full",
      );
    });

    it("countered: nothing moves", () => {
      const s = only(heist("countered"));
      expect(s.sentence).toBe("Ada played Tea Heist on Ben — countered, the card stays with Ben");
      expect(s.statusLabel).toBe("countered");
      expect(s.statusKind).toBe("negated");
    });

    it("reads heist_reason off the raw Trace step", () => {
      const [parsed] = parseResolutionTrace([
        {
          index: 0,
          display_kind: "card_heist",
          source_cast: { cast_id: "C1", active_effect_id: null, card_name: "Tea Heist", caster_player_id: "ada" },
          target_player: "ben",
          before: { type: "status", value: "held" },
          after: { type: "status", value: "fizzled" },
          outcome: "no-op",
          heist_reason: "victim_played_first",
        },
      ]);
      expect(parsed!.heistReason).toBe("victim_played_first");
      expect(parseResolutionTrace([{ ...step(), display_kind: "flat_modifier" }])[0]!.heistReason).toBeNull();
    });
  });

  describe("Marked for Brew (issue #436)", () => {
    const mark = (after: "marked" | "redirected" | "fizzled") =>
      step({
        displayKind: "draw_redirect",
        sourceCast: { castId: "C1", activeEffectId: null, cardName: "Marked for Brew", casterPlayerId: "ada" },
        targetPlayer: "ben",
        before: { type: "status", value: after === "marked" ? null : "marked" },
        after: { type: "status", value: after },
        outcome: after === "fizzled" ? "no-op" : "applied",
      });
    const only = (model: ReturnType<typeof buildRoundRecap>) => model.phases.flatMap((p) => p.steps)[0]!;
    const casts = [cast({ castId: "C1", cardName: "Marked for Brew", casterPlayerId: "ada", targetPlayerId: "ben", effectKind: "draw_redirect" })];

    it("marked: says whose crit the caster will draw, in the Outcome group", () => {
      const model = buildRoundRecap({ data: data({ casts, trace: [mark("marked")] }), displayName });
      const s = only(model);
      expect(s.sentence).toBe(
        "Ada played Marked for Brew — Ben is marked: Ada draws the card for Ben's next nat 1 or nat 20 within 5 rounds",
      );
      expect(s).toMatchObject({ statusLabel: "marked", statusKind: "applied", beforeAfter: null });
      expect(model.phases.find((p) => p.label === "Outcome")?.steps).toHaveLength(1);
    });

    it("redirected: the mark fires in a later round with no casts of its own", () => {
      const model = buildRoundRecap({ data: data({ trace: [mark("redirected")] }), displayName });
      expect(model.hasContent).toBe(true);
      const s = only(model);
      expect(s.sentence).toBe("Marked for Brew — Ben rolled a nat 1 or nat 20, so Ada draws the card instead");
      expect(s).toMatchObject({ statusLabel: "redirected", statusKind: "applied" });
    });

    it("fizzled: the caster already had a draw, so the target keeps theirs", () => {
      const s = only(buildRoundRecap({ data: data({ trace: [mark("fizzled")] }), displayName }));
      expect(s.sentence).toBe(
        "Marked for Brew — fizzled: Ada already has a card to draw this round, so Ben draws their own",
      );
      expect(s).toMatchObject({ statusLabel: "fizzled", statusKind: "no-op" });
    });
  });

  describe("Last Drip (issue #426)", () => {
    function lastDrip(over: Partial<ResolutionTraceStep>, recap: Partial<RoundRecapData> = {}) {
      return buildRoundRecap({
        data: data({
          casts: [cast({ castId: "C1", cardName: "Last Drip", casterPlayerId: "ada", targetPlayerId: null, effectKind: "tea_maker_override" })],
          trace: [
            step({
              displayKind: "tea_maker_override",
              sourceCast: { castId: "C1", activeEffectId: null, cardName: "Last Drip", casterPlayerId: "ada" },
              targetPlayer: "ben",
              before: { type: "status", value: "pending" },
              after: { type: "status", value: "brewer (no modifier gain)" },
              ...over,
            }),
          ],
          ...recap,
        }),
        displayName,
      });
    }
    const only = (model: ReturnType<typeof buildRoundRecap>) => model.phases.flatMap((p) => p.steps)[0]!;
    const inert = { after: { type: "status", value: "no effect" }, outcome: "no-op" } as const;

    it("the previous winner brews with no modifier gain", () => {
      expect(only(lastDrip({})).sentence).toBe("Ada played Last Drip — Ben brews (no modifier gain)");
    });

    it("inert with no previous round: a no-effect step saying why", () => {
      const s = only(lastDrip({ ...inert, targetPlayer: null, overrideReason: "no_previous_round" }));
      expect(s.sentence).toBe("Ada played Last Drip — no effect: there's no previous round");
      expect(s.statusLabel).toBe("no effect");
      expect(s.statusKind).toBe("no-op");
    });

    it("inert when the previous winner isn't taking part", () => {
      expect(only(lastDrip({ ...inert, overrideReason: "target_absent" })).sentence).toBe(
        "Ada played Last Drip — no effect: Ben isn't in this round",
      );
    });

    it("provisional: neither the brewer nor the inert step is shown", () => {
      for (const over of [{}, { ...inert, overrideReason: "target_absent" as const }]) {
        const model = lastDrip(over, { resolved: false, provisional: true, layerZeroOutcome: null });
        expect(model.phases.map((p) => p.label)).not.toContain("Outcome");
      }
    });

    it("reads override_reason off the raw Trace step", () => {
      const [parsed] = parseResolutionTrace([
        {
          index: 0,
          display_kind: "tea_maker_override",
          source_cast: { cast_id: "C1", active_effect_id: null, card_name: "Last Drip", caster_player_id: "ada" },
          target_player: null,
          before: { type: "status", value: "pending" },
          after: { type: "status", value: "no effect" },
          outcome: "no-op",
          override_reason: "no_previous_round",
        },
      ]);
      expect(parsed!.overrideReason).toBe("no_previous_round");
      expect(parsed!.failedOverrideCondition).toBeNull();
      expect(parseResolutionTrace([{ ...step(), display_kind: "flat_modifier" }])[0]!.overrideReason).toBeNull();
    });
  });

  describe("PG Tipped (issue #427)", () => {
    function pgTipped(after: string, over: Partial<ResolutionTraceStep> = {}) {
      return buildRoundRecap({
        data: data({
          casts: [cast({ castId: "C1", cardName: "PG Tipped", casterPlayerId: "ada", targetPlayerId: "ben", effectKind: "tea_maker_override" })],
          trace: [
            step({
              displayKind: "tea_maker_override",
              sourceCast: { castId: "C1", activeEffectId: null, cardName: "PG Tipped", casterPlayerId: "ada" },
              targetPlayer: "ben",
              before: { type: "status", value: "pending" },
              after: { type: "status", value: after },
              ...over,
            }),
          ],
        }),
        displayName,
      });
    }
    const only = (model: ReturnType<typeof buildRoundRecap>) => model.phases.flatMap((p) => p.steps)[0]!;
    const notMet = (targetRoll: number | null, casterRoll: number | null) =>
      ({
        outcome: "no-op",
        overrideReason: "condition_not_met",
        failedOverrideCondition: { condition: "target_below_caster", targetRoll, casterRoll },
      }) as const;

    it("condition met: the target brews with no modifier gain", () => {
      const s = only(pgTipped("brewer (no modifier gain)"));
      expect(s.sentence).toBe("Ada played PG Tipped — Ben brews (no modifier gain)");
      expect(s.statusKind).toBe("applied");
    });

    it("condition not met: a no-op Outcome step naming both rolls", () => {
      const model = pgTipped("condition not met", notMet(12, 9));
      const s = only(model);
      expect(s.sentence).toBe(
        "Ada played PG Tipped on Ben — condition not met: Ben rolled 12, not lower than Ada's 9, so it doesn't pick the brewer",
      );
      expect(s.statusLabel).toBe("condition not met");
      expect(s.statusKind).toBe("no-op");
      expect(model.phases.find((p) => p.label === "Outcome")?.steps).toHaveLength(1);
    });

    it("condition not met without a recorded roll: no numbers in the sentence", () => {
      const s = only(pgTipped("condition not met", notMet(null, 9)));
      expect(s.sentence).toBe("Ada played PG Tipped on Ben — condition not met, so it doesn't pick the brewer");
    });

    it("reads the override condition off the raw Trace step", () => {
      const [parsed] = parseResolutionTrace([
        {
          index: 0,
          display_kind: "tea_maker_override",
          source_cast: { cast_id: "C1", active_effect_id: null, card_name: "PG Tipped", caster_player_id: "ada" },
          target_player: "ben",
          before: { type: "status", value: "pending" },
          after: { type: "status", value: "condition not met" },
          outcome: "no-op",
          override_reason: "condition_not_met",
          override_condition: "target_below_caster",
          target_roll: 12,
          caster_roll: 9,
        },
      ]);
      expect(parsed!.overrideReason).toBe("condition_not_met");
      expect(parsed!.failedOverrideCondition).toEqual({
        condition: "target_below_caster",
        targetRoll: 12,
        casterRoll: 9,
      });
      expect(parseResolutionTrace([{ ...step(), display_kind: "flat_modifier" }])[0]!.failedOverrideCondition).toBeNull();
    });
  });

  describe("Tea Party Revolt (issue #430)", () => {
    function revolt(over: Partial<ResolutionTraceStep>) {
      return buildRoundRecap({
        data: data({
          casts: [cast({ castId: "C1", cardName: "Tea Party Revolt", casterPlayerId: "ada", targetPlayerId: "ben", effectKind: "tea_maker_override" })],
          trace: [
            step({
              displayKind: "tea_maker_override",
              sourceCast: { castId: "C1", activeEffectId: null, cardName: "Tea Party Revolt", casterPlayerId: "ada" },
              targetPlayer: "ben",
              before: { type: "status", value: "pending" },
              after: { type: "status", value: "brewer" },
              ...over,
            }),
          ],
        }),
        displayName,
      });
    }
    const only = (model: ReturnType<typeof buildRoundRecap>) => model.phases.flatMap((p) => p.steps)[0]!;
    const inert = { targetPlayer: null, after: { type: "status", value: "no effect" }, outcome: "no-op" } as const;

    it("the lowest roller's pick brews, and the sentence says who picked", () => {
      const s = only(revolt({ pickedBy: "cass" }));
      expect(s.sentence).toBe("Ada played Tea Party Revolt — Cass, the lowest roller, picks Ben to brew");
      expect(s.statusKind).toBe("applied");
    });

    it("a stalled pick: a no-effect step saying the pick was never made", () => {
      const s = only(revolt({ ...inert, overrideReason: "pick_abandoned" }));
      expect(s.sentence).toBe("Ada played Tea Party Revolt — no effect: the lowest roller never picked who brews");
      expect(s.statusKind).toBe("no-op");
    });

    it("a pick still outstanding (provisional): says it's waiting", () => {
      const s = only(revolt({ ...inert, overrideReason: "pick_pending" }));
      expect(s.sentence).toBe("Ada played Tea Party Revolt — no effect: the lowest roller hasn't picked yet");
    });

    it("reads picked_by off the raw Trace step", () => {
      const [parsed] = parseResolutionTrace([
        {
          index: 0,
          display_kind: "tea_maker_override",
          source_cast: { cast_id: "C1", active_effect_id: null, card_name: "Tea Party Revolt", caster_player_id: "ada" },
          target_player: "ben",
          before: { type: "status", value: "pending" },
          after: { type: "status", value: "brewer" },
          outcome: "applied",
          picked_by: "cass",
        },
      ]);
      expect(parsed!.pickedBy).toBe("cass");
      expect(parseResolutionTrace([{ ...step(), display_kind: "flat_modifier" }])[0]!.pickedBy).toBeNull();
    });
  });

  it("per-round dice tick (Calami-Tea): sentence names the rolled die, not the before→after delta", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [cast({ castId: "C1", cardName: "Calami-Tea", casterPlayerId: "ada", targetPlayerId: "cass", effectKind: "per_round_dice_tick" })],
        trace: [
          step({
            displayKind: "dice_tick",
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Calami-Tea", casterPlayerId: "ada" },
            targetPlayer: "cass",
            before: { type: "roll", value: 14 },
            after: { type: "roll", value: 11 },
            outcome: "applied",
            diceTick: { die: 4, rolled: 3 },
          }),
        ],
      }),
      displayName,
    });
    const s = model.phases.flatMap((p) => p.steps)[0]!;
    expect(s.sentence).toBe("Ada played Calami-Tea — Cass subtracts 3 from their roll");
    expect(s.beforeAfter).toEqual({ label: "roll", from: "14", to: "11", unchanged: false });
  });

  it("per-round dice tick: names the true rolled die even when the roll floors at 1 (delta would under-report)", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [cast({ castId: "C1", cardName: "Calami-Tea", casterPlayerId: "ada", targetPlayerId: "cass", effectKind: "per_round_dice_tick" })],
        trace: [
          step({
            displayKind: "dice_tick",
            sourceCast: { castId: "C1", activeEffectId: null, cardName: "Calami-Tea", casterPlayerId: "ada" },
            targetPlayer: "cass",
            before: { type: "roll", value: 3 },
            after: { type: "roll", value: 1 }, // floored: 3 - 4 -> 1, delta only 2
            outcome: "applied",
            diceTick: { die: 4, rolled: 4 },
          }),
        ],
      }),
      displayName,
    });
    const s = model.phases.flatMap((p) => p.steps)[0]!;
    expect(s.sentence).toBe("Ada played Calami-Tea — Cass subtracts 4 from their roll");
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
    summary: null,
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
    expect(model.firstAttemptRolls[2]!.row.enteredByAdmin).toBe(true);
  });

  it("#408: rows show the generation's own Resolution Summary and Trace terms", () => {
    const model = buildScrappedGenerationRecap(
      scrappedGen({
        summary: [
          { playerId: "ada", roll: 10, snapshot: 2, composed: 7, total: 17, nat: null, diceReduced: false },
          { playerId: "ben", roll: 12, snapshot: 0, composed: 0, total: 12, nat: null, diceReduced: false },
        ],
        trace: [
          step({ targetPlayer: "ada", before: { type: "modifier", value: 2 }, after: { type: "modifier", value: 7 } }),
        ],
      }),
      displayName,
      ["ada", "ben"],
    );
    const [ada, ben] = model.firstAttemptRolls;
    expect(ada!.row).toMatchObject({ total: 17, composed: 7, badgeValue: 17, degraded: false });
    expect(ada!.row.terms.map((t) => [t.cardName, t.delta])).toEqual([["Lucky Sip", 5]]);
    expect(ben!.row).toMatchObject({ total: 12, degraded: false });
  });

  it("#408: a generation scrapped before summaries existed renders degraded rows", () => {
    const model = buildScrappedGenerationRecap(scrappedGen({ summary: null }), displayName, ["ada", "ben"]);
    expect(model.firstAttemptRolls.map((r) => [r.playerId, r.row.roll, r.row.total, r.row.degraded])).toEqual([
      ["ada", 10, null, true],
      ["ben", 12, null, true],
    ]);
  });
});

// --- Per-player roll rows (issue #407) ----------------------------------

function summary(playerId: string, over: Partial<ResolutionSummaryEntry> = {}): ResolutionSummaryEntry {
  const roll = over.roll ?? 10;
  const composed = over.composed ?? 0;
  return {
    playerId,
    roll,
    snapshot: 0,
    composed,
    total: roll + composed,
    nat: null,
    diceReduced: false,
    ...over,
  };
}

const layer0 = (...rolls: ReturnType<typeof lr>[]): CompletedLayer[] => [{ layer: 0, rolls }];

describe("buildRoundRecap rows", () => {
  it("total, composed and nat come from the Resolution Summary, not recomputed", () => {
    const model = buildRoundRecap({
      data: data({
        // A summary that disagrees with roll + snapshot on purpose: the row
        // must show the resolver's numbers.
        summary: [summary("ada", { roll: 7, snapshot: 1, composed: 4, total: 11 }), summary("ben", { roll: 1, nat: "nat1", total: 3, composed: 2 })],
        layers: layer0(lr("ada", 7, 1), lr("ben", 1, 2)),
      }),
      displayName,
    });
    expect(model.rows.find((r) => r.playerId === "ada")).toMatchObject({
      roll: 7,
      snapshot: 1,
      composed: 4,
      total: 11,
      nat: null,
      badgeValue: 11,
      degraded: false,
    });
    expect(model.rows.find((r) => r.playerId === "ben")).toMatchObject({ nat: "nat1", badgeValue: 1 });
  });

  it("a Calami-Tea-floored 1 is not a nat 1 — the summary says so and the row follows", () => {
    const model = buildRoundRecap({
      data: data({
        summary: [summary("ada", { roll: 1, total: 1, diceReduced: true, nat: null })],
        layers: layer0(lr("ada", 2)),
      }),
      displayName,
    });
    expect(model.rows[0]).toMatchObject({ roll: 1, nat: null, badgeValue: 1, diceReduced: true });
  });

  it("terms are the Trace steps targeting the player, with card, caster and before→after", () => {
    const model = buildRoundRecap({
      data: data({
        summary: [summary("ada", { composed: 3, total: 13 }), summary("ben")],
        layers: layer0(lr("ada", 10), lr("ben", 10)),
        trace: [
          step({ targetPlayer: "ada", before: { type: "modifier", value: 0 }, after: { type: "modifier", value: 3 } }),
          step({
            displayKind: "roll_flip",
            sourceCast: { castId: "C9", activeEffectId: null, cardName: "Topsy Turvy", casterPlayerId: "ben" },
            targetPlayer: "ben",
            before: { type: "roll", value: 10 },
            after: { type: "roll", value: 11 },
          }),
        ],
      }),
      displayName,
    });
    const ada = model.rows.find((r) => r.playerId === "ada")!;
    expect(ada.terms).toEqual([
      {
        displayKind: "flat_modifier",
        domain: "modifier",
        cardName: "Lucky Sip",
        casterName: "Cass",
        from: 0,
        to: 3,
        delta: 3,
        struck: null,
        restOfDay: false,
        pending: false,
      },
    ]);
    const ben = model.rows.find((r) => r.playerId === "ben")!;
    expect(ben.terms).toMatchObject([{ domain: "roll", cardName: "Topsy Turvy", from: 10, to: 11, delta: null }]);
  });

  it("warded, negated and redirected-away steps are struck terms", () => {
    const model = buildRoundRecap({
      data: data({
        summary: [summary("ada"), summary("ben")],
        layers: layer0(lr("ada", 10), lr("ben", 10)),
        trace: [
          // a redirect moved a cast aimed at ada onto ben
          step({
            displayKind: "redirect",
            sourceCast: { castId: "C7", activeEffectId: null, cardName: "Mug Swap", casterPlayerId: "ada" },
            targetPlayer: "ben",
            before: { type: "target", value: "ada" },
            after: { type: "target", value: "ben" },
          }),
          // a negated victim step on ada
          step({
            displayKind: "flat_modifier",
            sourceCast: { castId: null, activeEffectId: null, cardName: "Bad Brew", casterPlayerId: "cass" },
            targetPlayer: "ada",
            before: { type: "status", value: "negated" },
            after: { type: "status", value: "negated" },
            negated: true,
          }),
          // a ward blocked a flat modifier on ben
          step({
            displayKind: "warded",
            targetPlayer: "ben",
            before: { type: "modifier", value: 0 },
            after: { type: "modifier", value: -2 },
            outcome: "blocked",
            ward: { wardCastId: "W1", wardCardName: "Bag for Life" },
          }),
        ],
      }),
      displayName,
    });
    const ada = model.rows.find((r) => r.playerId === "ada")!;
    expect(ada.terms.map((t) => [t.cardName, t.struck])).toEqual([
      ["Mug Swap", "redirected"],
      ["Bad Brew", "negated"],
    ]);
    const ben = model.rows.find((r) => r.playerId === "ben")!;
    // the redirect step itself lands on ben as a status step, not a term; the
    // redirected effect's own modifier step would be ben's applied term.
    expect(ben.terms.map((t) => [t.cardName, t.struck, t.delta])).toEqual([["Lucky Sip", "warded", null]]);
  });

  it("a countered redirect (target unchanged) strikes nothing", () => {
    const model = buildRoundRecap({
      data: data({
        summary: [summary("ada")],
        layers: layer0(lr("ada", 10)),
        trace: [
          step({
            displayKind: "redirect",
            targetPlayer: "ben",
            before: { type: "target", value: "ada" },
            after: { type: "target", value: "ada" },
          }),
        ],
      }),
      displayName,
    });
    expect(model.rows[0]!.terms).toEqual([]);
  });

  it("rest-of-day and pending-die steps are terms that don't count toward the total", () => {
    const model = buildRoundRecap({
      data: data({
        summary: [summary("ada")],
        layers: layer0(lr("ada", 10)),
        trace: [
          step({
            displayKind: "persistent_modifier_transfer",
            targetPlayer: "ada",
            before: { type: "modifier", value: 4 },
            after: { type: "modifier", value: 3 },
            restOfDay: true,
          }),
          step({
            displayKind: "dice_tick",
            targetPlayer: "ada",
            before: { type: "roll", value: 10 },
            after: { type: "roll", value: 10 },
            diceTick: null,
            compel: null,
          }),
        ],
      }),
      displayName,
    });
    expect(model.rows[0]!.terms.map((t) => [t.displayKind, t.restOfDay, t.pending, t.delta])).toEqual([
      ["persistent_modifier_transfer", true, false, null],
      ["dice_tick", false, true, null],
    ]);
  });

  it("the provisional flag passes through to every row", () => {
    const model = buildRoundRecap({
      data: data({ resolved: false, provisional: true, summary: [summary("ada")], layers: layer0(lr("ada", 10)) }),
      displayName,
    });
    expect(model.provisional).toBe(true);
    expect(model.rows[0]!.provisional).toBe(true);
  });

  it("no summary (a round resolved before it existed): degraded row — roll, snapshot, terms, no total", () => {
    const model = buildRoundRecap({
      data: data({
        summary: null,
        layers: layer0(lr("ada", 1, 2)),
        trace: [step({ targetPlayer: "ada", before: { type: "modifier", value: 2 }, after: { type: "modifier", value: 5 } })],
      }),
      displayName,
    });
    expect(model.rows[0]).toMatchObject({
      playerId: "ada",
      roll: 1,
      snapshot: 2,
      composed: null,
      total: null,
      nat: null,
      badgeValue: null,
      degraded: true,
    });
    expect(model.rows[0]!.terms).toHaveLength(1);
  });

  it("provisional (live dry run): the Ledger shows the Trace's steps so far, numbered, but never a tie", () => {
    const c1 = cast({ castId: "C1", targetPlayerId: "ada" });
    const model = buildRoundRecap({
      data: data({
        resolved: false,
        provisional: true,
        layerZeroOutcome: null,
        casts: [c1],
        summary: [summary("ada", { composed: 3, total: 13 })],
        layers: layer0(lr("ada", 10)),
        trace: [
          step({ targetPlayer: "ada", before: { type: "modifier", value: 0 }, after: { type: "modifier", value: 3 } }),
          // the dry run's brewer pick — must not be announced while provisional
          step({
            displayKind: "tea_maker_override",
            targetPlayer: "ada",
            before: { type: "status", value: "pending" },
            after: { type: "status", value: "brewer" },
          }),
        ],
      }),
      displayName,
    });
    const steps = model.phases.flatMap((p) => p.steps);
    expect(steps.map((s) => [s.displayIndex, s.pending, s.beforeAfter?.to])).toEqual([["1", false, "3"]]);
    expect(model.phases.map((p) => p.label)).not.toContain("Outcome");
    expect(model.castStrip.map((c) => c.state)).toEqual(["applied"]);
    expect(model.endedInTieBreak).toBe(false);
    expect(model.provisional).toBe(true);
  });

  it("zero-cast round still gets rows", () => {
    const model = buildRoundRecap({
      data: data({ summary: [summary("ada")], layers: layer0(lr("ada", 10)) }),
      displayName,
    });
    expect(model.hasContent).toBe(false);
    expect(model.rows).toHaveLength(1);
  });

  it("no layer-0 rolls and no summary yet: no rows", () => {
    expect(buildRoundRecap({ data: data({ resolved: false }), displayName }).rows).toEqual([]);
  });
});

// --- Reroll Chain (issue #406) ------------------------------------------

function lr(playerId: string, value: number, modifierSnapshot = 0) {
  return { playerId, value, modifierSnapshot, discardedValue: null, enteredByAdmin: false };
}
const parts = (layer: number, ...ids: string[]) => ids.map((playerId) => ({ layer, playerId }));

describe("buildRerollChain", () => {
  it("resolved outright at layer 0: nobody is in layer 1, so no chain", () => {
    const layers: CompletedLayer[] = [{ layer: 0, rolls: [lr("ada", 15), lr("ben", 8)] }];
    expect(buildRerollChain("ben", layers, [])).toEqual([]);
  });

  it("plain tie: every layer-1 participant gets one resolved level", () => {
    const layers: CompletedLayer[] = [
      { layer: 0, rolls: [lr("ada", 15), lr("ben", 7, 3), lr("cass", 4, 6)] },
      { layer: 1, rolls: [lr("ben", 9, 3), lr("cass", 12, 6)] },
    ];
    const lp = parts(1, "ben", "cass");
    expect(buildRerollChain("ben", layers, lp)).toEqual([
      { layer: 1, roll: 9, modifier: 3, nat: null, badgeValue: 12, tied: false },
    ]);
    expect(buildRerollChain("cass", layers, lp)).toEqual([
      { layer: 1, roll: 12, modifier: 6, nat: null, badgeValue: 18, tied: false },
    ]);
    expect(buildRerollChain("ada", layers, lp)).toEqual([]);
  });

  it("spell-created tie: roll-time sums differ, but next-layer membership says they tied", () => {
    // ada 10+0 vs ben 12+0 never tie on roll-time modifiers; a spell made the
    // composed totals equal, and the resolver sent both to layer 1.
    const layers: CompletedLayer[] = [
      { layer: 0, rolls: [lr("ada", 10), lr("ben", 12), lr("cass", 18)] },
      { layer: 1, rolls: [lr("ada", 5), lr("ben", 14)] },
    ];
    const lp = parts(1, "ada", "ben");
    expect(buildRerollChain("ada", layers, lp).map((l) => l.layer)).toEqual([1]);
    expect(buildRerollChain("ben", layers, lp).map((l) => l.layer)).toEqual([1]);
    expect(buildRerollChain("cass", layers, lp)).toEqual([]);
  });

  it("multi-layer tie: tied at N exactly when in layer N+1", () => {
    const layers: CompletedLayer[] = [
      { layer: 0, rolls: [lr("ada", 15), lr("ben", 7), lr("cass", 7)] },
      { layer: 1, rolls: [lr("ben", 5), lr("cass", 5)] },
      { layer: 2, rolls: [lr("ben", 9), lr("cass", 3)] },
    ];
    const lp = [...parts(1, "ben", "cass"), ...parts(2, "ben", "cass")];
    expect(buildRerollChain("ben", layers, lp).map((l) => [l.layer, l.tied])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("a next layer that has not finished rolling is not shown yet, but the tie is", () => {
    const layers: CompletedLayer[] = [
      { layer: 0, rolls: [lr("ada", 15), lr("ben", 7), lr("cass", 7)] },
      { layer: 1, rolls: [lr("ben", 5), lr("cass", 5)] },
    ];
    const lp = [...parts(1, "ben", "cass"), ...parts(2, "ben", "cass")];
    expect(buildRerollChain("ben", layers, lp)).toEqual([
      { layer: 1, roll: 5, modifier: 0, nat: null, badgeValue: 5, tied: true },
    ]);
  });

  // ADR 0007: tie-break layers have no spell logic and no summary, so their
  // nat standing stays a TS rule — pinned here to _rr_pick_lowest's 3-argument
  // form (no dice-reduced exemption at layer > 0): a 1 is a natural 1 and a 20
  // a natural 20 regardless of modifier, and the badge shows the bare roll.
  it("tie-layer nat-1 / nat-20 follow the resolver's 3-argument lowest-pick rule", () => {
    const layers: CompletedLayer[] = [
      { layer: 0, rolls: [lr("ada", 7, 2), lr("ben", 7, 2)] },
      { layer: 1, rolls: [lr("ada", 1, 9), lr("ben", 20, -4)] },
    ];
    const lp = parts(1, "ada", "ben");
    expect(buildRerollChain("ada", layers, lp)[0]).toMatchObject({ nat: "nat1", badgeValue: 1 });
    expect(buildRerollChain("ben", layers, lp)[0]).toMatchObject({ nat: "nat20", badgeValue: 20 });
  });
});

describe("buildRoundRecap: the reaction window's not-heard-from line (issue #411)", () => {
  it("a zero-cast round whose window was skipped still gets a Recap with the line", () => {
    const model = buildRoundRecap({
      data: data({ reactionSkips: [{ playerId: "ada", reason: "vote" }, { playerId: "ben", reason: "vote" }] }),
      displayName,
    });
    expect(model.hasContent).toBe(true);
    expect(model.phases).toEqual([
      {
        label: "Reaction window",
        steps: [
          expect.objectContaining({
            displayKind: "not_heard_from",
            sentence: "Not heard from Ada and Ben: skipped by vote",
            statusLabel: "skipped",
            castId: null,
            displayIndex: "",
          }),
        ],
      },
    ]);
  });

  it("names a timeout, and sits after the last Reaction window step and before the Outcome", () => {
    const pre = cast({ castId: "C1", phase: "preroll" });
    const reaction = cast({ castId: "C2", phase: "reaction", cardName: "Mug Shot" });
    const model = buildRoundRecap({
      data: data({
        casts: [pre, reaction],
        trace: [
          step({ sourceCast: { castId: "C1", activeEffectId: null, cardName: "Lucky Sip", casterPlayerId: "cass" } }),
          step({ sourceCast: { castId: "C2", activeEffectId: null, cardName: "Mug Shot", casterPlayerId: "cass" } }),
          step({
            displayKind: "tea_maker_override",
            sourceCast: { castId: null, activeEffectId: null, cardName: null, casterPlayerId: null },
            before: { type: "status", value: null },
            after: { type: "status", value: null },
          }),
        ],
        reactionSkips: [{ playerId: "dev", reason: "timeout" }],
      }),
      displayName,
    });

    expect(model.phases.map((p) => p.label)).toEqual(["Before the roll", "Reaction window", "Outcome"]);
    const reactionSteps = model.phases[1]!.steps;
    expect(reactionSteps.at(-1)).toMatchObject({
      sentence: "Not heard from Dev: timed out after 5 minutes",
      statusLabel: "timed out",
    });
  });
});

describe("buildRoundRecap: Brewmageddon (issue #440)", () => {
  const BM = "BM";
  const bmCast = () =>
    cast({ castId: BM, cardName: "Brewmageddon", casterPlayerId: "ada", targetPlayerId: null, effectKind: "compel_cast" });
  const compelStep = (compelledPlayerIds: string[]) =>
    step({
      displayKind: "compel_cast",
      sourceCast: { castId: BM, activeEffectId: null, cardName: "Brewmageddon", casterPlayerId: "ada" },
      targetPlayer: null,
      before: { type: "status", value: "cast" },
      after: { type: "status", value: "compelled" },
      outcome: compelledPlayerIds.length > 0 ? "applied" : "no-op",
      compel: { compelledPlayerIds, compelledByCastId: null, reason: null },
    });
  const forfeitStep = (castId: string, player: string, cardName: string, reason: ForfeitReason) =>
    step({
      displayKind: "forfeit",
      sourceCast: { castId, activeEffectId: null, cardName, casterPlayerId: player },
      targetPlayer: player,
      before: { type: "status", value: "held" },
      after: { type: "status", value: "forfeited" },
      outcome: "no-op",
      compel: { compelledPlayerIds: [], compelledByCastId: BM, reason },
    });

  it("the Brewmageddon step names who it compelled", () => {
    const model = buildRoundRecap({
      data: data({ casts: [bmCast()], trace: [compelStep(["ben", "cass"])] }),
      displayName,
    });
    const s = model.phases[0]!.steps[0]!;
    expect(s.sentence).toBe("Ada played Brewmageddon — Ben and Cass must play their card");
    expect(s.statusLabel).toBe("applied");
  });

  it("with nobody holding a card the Brewmageddon step is a no-op", () => {
    const model = buildRoundRecap({ data: data({ casts: [bmCast()], trace: [compelStep([])] }), displayName });
    const s = model.phases[0]!.steps[0]!;
    expect(s.sentence).toBe("Ada played Brewmageddon — nobody held a card");
    expect(s.statusLabel).toBe("no effect");
  });

  it.each<[ForfeitReason, string]>([
    ["no_legal_target", "it had no legal target"],
    ["stall", "they never played it"],
    ["excluded", "they never rolled"],
    ["vote", "they were skipped by vote"],
    ["timeout", "they timed out"],
  ])("a Forfeit (%s) names the card, the reason, and Brewmageddon", (reason, why) => {
    const model = buildRoundRecap({
      data: data({
        casts: [
          bmCast(),
          cast({ castId: "F1", cardName: "Stir the Pot", casterPlayerId: "ben", effectKind: "forfeit", compelledByCastId: BM }),
        ],
        trace: [compelStep(["ben"]), forfeitStep("F1", "ben", "Stir the Pot", reason)],
      }),
      displayName,
    });
    const s = model.phases[0]!.steps[1]!;
    expect(s.sentence).toBe(`Ben's Stir the Pot is forfeited to Brewmageddon — ${why}`);
    expect(s.statusLabel).toBe("forfeited");
    expect(s.statusKind).toBe("no-op");
  });

  it("a compelled cast's step and chip link back to Brewmageddon; other chips don't", () => {
    const model = buildRoundRecap({
      data: data({
        casts: [
          bmCast(),
          cast({
            castId: "S1",
            cardName: "Sugar Rush",
            casterPlayerId: "ben",
            targetPlayerId: "ben",
            effectKind: "advantage",
            compelledByCastId: BM,
          }),
          cast({ castId: "F1", cardName: "Greater Detox", casterPlayerId: "cass", effectKind: "forfeit", compelledByCastId: BM }),
        ],
        trace: [
          compelStep(["ben", "cass"]),
          forfeitStep("F1", "cass", "Greater Detox", "no_legal_target"),
          step({
            displayKind: "advantage",
            sourceCast: { castId: "S1", activeEffectId: null, cardName: "Sugar Rush", casterPlayerId: "ben" },
            targetPlayer: "ben",
            before: { type: "roll", value: 6 },
            after: { type: "roll", value: 14 },
          }),
        ],
      }),
      displayName,
    });

    const chips = new Map(model.castStrip.map((c) => [c.castId, c]));
    expect(chips.get(BM)!.compelledBy).toBeUndefined();
    expect(chips.get("S1")!.compelledBy).toBe("Brewmageddon");
    expect(chips.get("F1")!.compelledBy).toBe("Brewmageddon");
    expect(chips.get("F1")!.state).toBe("no-op");

    const adv = model.phases.flatMap((p) => p.steps).find((s) => s.castId === "S1")!;
    expect(adv.sentence).toBe("Ben played Sugar Rush — Ben rolls with advantage (compelled by Brewmageddon)");
  });

  it("live round: a Forfeit and a compelled cast read as such before the Trace exists", () => {
    const model = buildRoundRecap({
      data: data({
        resolved: false,
        casts: [
          bmCast(),
          cast({
            castId: "S1",
            cardName: "Sugar Rush",
            casterPlayerId: "ben",
            targetPlayerId: "ben",
            effectKind: "advantage",
            compelledByCastId: BM,
          }),
          cast({
            castId: "F1",
            cardName: "Greater Detox",
            casterPlayerId: "cass",
            targetPlayerId: "cass",
            effectKind: "forfeit",
            compelledByCastId: BM,
          }),
        ],
      }),
      displayName,
    });
    const sentences = model.phases.flatMap((p) => p.steps).map((s) => s.sentence);
    expect(sentences).toEqual([
      "Ada played Brewmageddon",
      "Ben played Sugar Rush on Ben (compelled by Brewmageddon)",
      "Cass forfeited Greater Detox to Brewmageddon",
    ]);
  });
});
