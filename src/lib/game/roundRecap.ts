import type {
  LayerParticipant,
  ReactionSkip,
  RoundRecapCast,
  RoundRecapData,
  ScrappedGeneration,
} from "@/lib/supabase/roundRecap";
import type { CompletedLayer, ForfeitReason, OverrideNoopReason, ResolutionTraceStep } from "@/lib/supabase/rolls";
import { classifyRollCalculation } from "@/lib/game/rollCalculation";
import { joinNames } from "@/lib/game/displayName";

/**
 * One tie-break reroll level under a player's layer-0 row (issue #220). Layers
 * > 0 carry no spell logic and no Resolution Summary (ADR 0007), so the level
 * is the bare roll + roll-time modifier and its nat standing.
 */
export type RerollChainLevel = {
  layer: number;
  roll: number;
  modifier: number;
  nat: "nat1" | "nat20" | null;
  /** What the badge shows: roll + modifier, or the bare roll for a nat-1/nat-20. */
  badgeValue: number;
  /** true when this player went on into layer + 1 — this level tied again. */
  tied: boolean;
};

/**
 * Tie-layer nat standing and badge, via `classifyRollCalculation` — the one TS
 * nat rule ADR 0007 keeps, pinned to `_rr_pick_lowest`'s 3-argument form (the
 * rule the resolver applies at layer > 0): a 1 is a natural 1 and a 20 a
 * natural 20 whatever the modifier, with no Calami-Tea dice-reduced exemption
 * (no spells reach a tie layer). Layer-0 nat standing comes from the
 * Resolution Summary instead.
 */
function tieLayerStanding(roll: number, modifier: number): { nat: "nat1" | "nat20" | null; badgeValue: number } {
  const calc = classifyRollCalculation(roll, modifier);
  return calc.kind === "sum" ? { nat: null, badgeValue: calc.total } : { nat: calc.kind, badgeValue: roll };
}

/**
 * Issue #406: one player's Reroll Chain — every tie-break layer they rolled in,
 * in order. Tie membership is read, never re-judged: a player tied at layer N
 * exactly when they are in layer N+1's participant set (for a scrapped
 * generation, its own snapshotted set). So a layer-0 tie made or broken by
 * spell modifiers is drawn exactly as the resolver decided it.
 *
 * `layers` holds only fully-rolled layers; the walk stops at the first layer
 * the player is in but that has not finished rolling.
 */
export function buildRerollChain(
  playerId: string,
  layers: CompletedLayer[],
  layerParticipants: LayerParticipant[],
): RerollChainLevel[] {
  const rollsByLayer = new Map(layers.map((l) => [l.layer, l.rolls]));
  const inLayer = (layer: number) =>
    layerParticipants.some((lp) => lp.layer === layer && lp.playerId === playerId);

  const chain: RerollChainLevel[] = [];
  for (let layer = 1; inLayer(layer); layer += 1) {
    const own = rollsByLayer.get(layer)?.find((r) => r.playerId === playerId);
    if (!own) break;
    chain.push({
      layer,
      roll: own.value,
      modifier: own.modifierSnapshot,
      ...tieLayerStanding(own.value, own.modifierSnapshot),
      tied: inLayer(layer + 1),
    });
  }
  return chain;
}

/**
 * The Round Recap ("the Ledger", issue #314) — a pure transform from a round's
 * Resolution Trace + cast list into the two things the UI draws: a tap-to-
 * filter cast strip, and a flat, phase-grouped list of step rows in resolution
 * order. This module owns exactly one sentence template per `display_kind`;
 * `RoundRecap.tsx` owns none.
 *
 * "Phase-grouped in resolution order" means: the step list stays in the
 * resolver's own order and a phase header is inserted wherever the phase
 * changes from the previous step — so a label can recur (the resolver revisits
 * the reaction window for lowest-gains-highest after composing pre-roll
 * modifiers). Steps are never reordered into fixed phase buckets.
 *
 * Rendering modes:
 *  - resolved: steps come from the Trace, in resolution order, numbered.
 *  - provisional (issue #409, the Provisional Recap): the round is live but
 *    layer 0 is complete, so the Trace is the resolver's dry run — rendered
 *    exactly like a resolved one ("so far — reactions pending").
 *  - live (round closed, layer 0 not complete yet): there is no Trace, so pending
 *    steps are synthesised from the cast list in cast order (by seq), indexed
 *    `·`, and shimmer. On resolve they re-sort to resolution order — never
 *    predicted client-side.
 */

export type CastState =
  | "armed"
  | "on-stack"
  | "applied"
  | "negated"
  | "redirected"
  | "blocked"
  | "backfired"
  | "no-op";

export type CastChip = {
  castId: string;
  cardName: string;
  casterName: string;
  state: CastState;
  /**
   * Issue #440: the card that compelled this cast (Brewmageddon), on a
   * compelled cast or a Forfeit. Absent on every other chip.
   */
  compelledBy?: string;
};

export type BeforeAfter = {
  /** Short noun for what changed: "roll", "mod", or "" for a status-only step. */
  label: string;
  from: string;
  to: string;
  /** true when the effect resolved but moved nothing (spec §3 zero-impact). */
  unchanged: boolean;
};

export type RecapStep = {
  /** "·" while pending, else the 1-based position in resolution order. */
  displayIndex: string;
  castId: string | null;
  /** Raw display_kind, e.g. "flat_modifier" (the component humanises it). */
  displayKind: string;
  /** The one sentence this module owns for this kind. Plain text, names resolved. */
  sentence: string;
  targetPlayer: string | null;
  casterPlayerId: string | null;
  /** null for a status-only step, or when live (no numbers yet). */
  beforeAfter: BeforeAfter | null;
  /** Short chip label: "applied" / "negated" / "no effect" / "on stack" / … */
  statusLabel: string;
  statusKind: CastState | "pending";
  pending: boolean;
};

export type PhaseLabel = "Before the roll" | "Reaction window" | "Outcome";

export type PhaseGroup = {
  label: PhaseLabel;
  steps: RecapStep[];
};

export type RoundRecapModel = {
  /** false ⇒ zero-cast round: render the reveal exactly as today, no Recap. */
  hasContent: boolean;
  castStrip: CastChip[];
  phases: PhaseGroup[];
  /** Show the persistent "Cast order → resolution order" caption. */
  showReorderCaption: boolean;
  /** Layer 0 tied — the recap ends here and the tie-break rolls decide it. */
  endedInTieBreak: boolean;
  /**
   * Issue #407: one row per layer-0 roller, from the Resolution Summary and
   * the Trace. Present even for a zero-cast round (hasContent false).
   */
  rows: RollRow[];
  /** Issue #409: the whole model is a live dry run ("so far — reactions pending"). */
  provisional: boolean;
};

/**
 * One term on a player's roll row (issue #407): a Trace step that targets
 * them in the roll or modifier domain, or an effect that did not land on
 * them (struck).
 */
export type RollRowTerm = {
  displayKind: string;
  domain: "roll" | "modifier" | "status";
  cardName: string | null;
  casterName: string | null;
  from: number | null;
  to: number | null;
  /**
   * The step's own contribution to the composed modifier (to − from). Only
   * for an applied, this-round modifier step, so the row's terms plus its
   * snapshot add up to `composed`; null for everything else.
   */
  delta: number | null;
  /** Why this effect did not apply to this player, or null if it did. */
  struck: "warded" | "negated" | "redirected" | null;
  /** A rest-of-day transfer: moves the room modifier, not this round's total. */
  restOfDay: boolean;
  /** A Calami-Tea tick whose die is not rolled yet (Provisional Recap). */
  pending: boolean;
};

/** One player's layer-0 roll row (issue #407): rendered as-is, no arithmetic. */
export type RollRow = {
  playerId: string;
  /** Final roll from the summary; the revealed layer-0 roll when degraded. */
  roll: number;
  discardedRoll: number | null;
  enteredByAdmin: boolean;
  snapshot: number;
  /** null ⇒ degraded (no summary). */
  composed: number | null;
  total: number | null;
  nat: "nat1" | "nat20" | null;
  diceReduced: boolean;
  /** The badge: total, or the bare roll for a nat-1/nat-20; null when degraded. */
  badgeValue: number | null;
  terms: RollRowTerm[];
  provisional: boolean;
  /** A round resolved before Resolution Summaries existed (ADR 0007). */
  degraded: boolean;
};

export type BuildRoundRecapArgs = {
  data: RoundRecapData;
  displayName: (playerId: string) => string;
  /**
   * Issue #352: render the step rows from `data.trace` alone even when
   * `data.casts` is empty — a scrapped replay generation keeps its Trace but
   * not its cast list. The tap-to-filter cast strip is absent in this mode.
   * Only takes effect for a resolved round with a non-empty Trace.
   */
  traceOnly?: boolean;
};

// contested_negate steps carry their outcome in `after.value` as one of these
// literals (migration 0080 / 0085 _rr_trace_step). Kept as named constants so
// the string contract with the SQL side is greppable from one place.
const CONTEST_COUNTERED = "countered";
const CONTEST_BACKFIRED = "backfired";
const CONTEST_NO_EFFECT = "no effect";

const OUTCOME_KINDS = new Set([
  "declared_number_tea_maker",
  "tea_maker_override",
  // Issue #321: a Cloud of Cream (targeting_skip) skip is a resolver-computed
  // target-selection step, alongside the brewer-selection kinds.
  "targeting_skip",
  // Issue #428: brewer immunity passes a player over during brewer selection.
  "brewer_immunity",
  // Issue #429: a force on the Earl passes the title, then the override lands.
  "earl_transfer",
  // Issue #431: Loose Leaf turns the named brewer into a roll-off.
  "named_tea_maker_rolloff",
  // Issue #438: a Tea Heist's outcome is decided in the resolver's final phase.
  "card_heist",
  // Issue #432: Brew IOU creates a Brew Debt; a debt round pays one.
  "brew_debt",
  // Issue #436: Marked for Brew places a mark, or a mark fires on a crit.
  "draw_redirect",
]);

// Step kinds whose cast usually sits in an earlier round, so a round can have
// them with no casts of its own (see traceDriven in buildRoundRecap).
const TRACE_ONLY_KINDS = new Set(["brew_debt", "draw_redirect"]);

// Issue #440: why a compelled card was forfeited (forfeit step `reason`).
// The compelling card's name when its cast row is not in view.
const BREWMAGEDDON = "Brewmageddon";

const FORFEIT_REASON_TEXT: Record<ForfeitReason, string> = {
  no_legal_target: "it had no legal target",
  stall: "they never played it",
  excluded: "they never rolled",
  vote: "they were skipped by vote",
  timeout: "they timed out",
};
// Issue #426: why a tea_maker_override step did nothing (`override_reason`).
const OVERRIDE_NOOP_TEXT: Record<OverrideNoopReason, (target: string) => string> = {
  no_previous_round: () => "there's no previous round",
  target_absent: (t) => `${t} isn't in this round`,
  // #427: normally read via failedOverrideCondition, which names the rolls.
  condition_not_met: () => "its condition wasn't met",
  // #430: Tea Party Revolt with no pick.
  pick_abandoned: () => "the lowest roller never picked who brews",
  pick_pending: () => "the lowest roller hasn't picked yet",
};
// card_heist steps carry their outcome in `after.value` (_rr_heist_trace).
const HEIST_MOVED = "moved";
const HEIST_FIZZLED = "fizzled";
const HEIST_COUNTERED = "countered";
// draw_redirect steps carry their outcome in `after.value` (_rr_draw_redirect_trace).
const MARK_PLACED = "marked";
const MARK_REDIRECTED = "redirected";
const MARK_FIZZLED = "fizzled";

function numeric(value: number | string | null): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * The terms on one player's row: every Trace step targeting them in the roll
 * or modifier domain (plus negated victim steps), in resolution order, and a
 * struck term for any cast a redirect moved off them.
 */
function termsFor(
  playerId: string,
  trace: ResolutionTraceStep[],
  displayName: (playerId: string) => string,
): RollRowTerm[] {
  const terms: RollRowTerm[] = [];
  for (const step of trace) {
    const cardName = step.sourceCast.cardName;
    const casterName = step.sourceCast.casterPlayerId ? displayName(step.sourceCast.casterPlayerId) : null;

    // A redirect step targets the NEW target; the player it was moved off
    // gets a struck term. A countered redirect (target unchanged) moved nothing.
    if (step.displayKind === "redirect") {
      if (step.before.value === playerId && step.after.value !== playerId) {
        terms.push({
          displayKind: step.displayKind,
          domain: "status",
          cardName,
          casterName,
          from: null,
          to: null,
          delta: null,
          struck: "redirected",
          restOfDay: false,
          pending: false,
        });
      }
      continue;
    }

    if (step.targetPlayer !== playerId) continue;
    const domain = step.before.type === "roll" || step.before.type === "modifier" ? step.before.type : "status";
    if (domain === "status" && !step.negated) continue;

    const struck: RollRowTerm["struck"] = step.negated
      ? "negated"
      : step.displayKind === "warded" || step.outcome === "blocked"
        ? "warded"
        : null;
    const from = numeric(step.before.value);
    const to = numeric(step.after.value);
    terms.push({
      displayKind: step.displayKind,
      domain,
      cardName,
      casterName,
      from,
      to,
      delta:
        domain === "modifier" && !struck && !step.restOfDay && from !== null && to !== null ? to - from : null,
      struck,
      restOfDay: step.restOfDay,
      pending: step.displayKind === "dice_tick" && step.diceTick === null,
    });
  }
  return terms;
}

/**
 * Issue #407: the per-player layer-0 rows. Numbers come from the Resolution
 * Summary; the revealed layer-0 rolls supply the discarded die / proxy flag,
 * and stand in (degraded, no total) for a round with no summary.
 */
function buildRows(data: RoundRecapData, displayName: (playerId: string) => string): RollRow[] {
  const layerZero = data.layers.find((l) => l.layer === 0)?.rolls ?? [];
  const rollByPlayer = new Map(layerZero.map((r) => [r.playerId, r]));

  if (data.summary) {
    return data.summary.map((entry) => {
      const revealed = rollByPlayer.get(entry.playerId);
      return {
        playerId: entry.playerId,
        roll: entry.roll,
        discardedRoll: revealed?.discardedValue ?? null,
        enteredByAdmin: revealed?.enteredByAdmin ?? false,
        snapshot: entry.snapshot,
        composed: entry.composed,
        total: entry.total,
        nat: entry.nat,
        diceReduced: entry.diceReduced,
        badgeValue: entry.nat ? entry.roll : entry.total,
        terms: termsFor(entry.playerId, data.trace, displayName),
        provisional: data.provisional,
        degraded: false,
      };
    });
  }

  return layerZero.map((r) => ({
    playerId: r.playerId,
    roll: r.value,
    discardedRoll: r.discardedValue,
    enteredByAdmin: r.enteredByAdmin,
    snapshot: r.modifierSnapshot,
    composed: null,
    total: null,
    nat: null,
    diceReduced: false,
    badgeValue: null,
    terms: termsFor(r.playerId, data.trace, displayName),
    provisional: data.provisional,
    degraded: true,
  }));
}

function humanKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

/** "roll" | "mod" | "" for the before→after pill. */
function pillLabel(type: string): string {
  if (type === "roll") return "roll";
  if (type === "modifier") return "mod";
  return "";
}

function fmt(value: number | string | null): string {
  if (value === null) return "—";
  return String(value);
}

/**
 * The single sentence template per display_kind. `t` is the target player's
 * display name, `c` the caster's, `k` the card name.
 */
function sentenceFor(
  step: ResolutionTraceStep,
  names: { t: string; c: string; k: string; compelled: string[]; compelledBy: string; pickedBy: string | null; newEarl: string; rolloffOpponents: string[] },
): string {
  const { t, c, k } = names;
  const played = k ? `${c} played ${k}` : c;

  // A negated victim step (source cast id dropped, `negated` flag set) carries
  // the victim's own effect_kind as displayKind — it is not a fresh effect.
  if (step.negated && step.displayKind !== "contested_negate") {
    return `${t}'s ${humanKind(step.displayKind)} was negated`;
  }

  switch (step.displayKind) {
    case "advantage":
      return `${played} — ${t} rolls with advantage`;
    case "disadvantage":
      return `${played} — ${t} rolls with disadvantage`;
    case "conditional_advantage":
      // Issue #319: Gambler's Infusion, first die met neither threshold — a
      // zero-impact step. (A met threshold resolves to advantage/disadvantage.)
      return step.condition
        ? `${played} — ${t}'s first die was ${step.condition.firstDie}; neither threshold met, the roll stands`
        : `${played} — ${t}'s roll stands`;
    case "forced_reroll":
      return `${played} — ${t} must reroll`;
    case "roll_flip":
      return `${played} — ${t}'s die is flipped`;
    case "roll_swap":
      return `${played} — ${t}'s die is swapped`;
    case "roll_pair_transform":
      // Issue #318: the chosen-pair op rides along as a 7-arg Trace extra.
      if (step.pairOp === "min") return `${played} — ${t} takes the lower of the linked pair`;
      if (step.pairOp === "max") return `${played} — ${t} takes the higher of the linked pair`;
      return `${played} — ${t}'s die is swapped with the linked player`;
    case "fixed_roll":
      return `${played} — ${t}'s die is fixed`;
    case "dice_tick": {
      // Issue #289: Calami-Tea — a fresh 1dN rolled against the target's roll
      // every round the effect is live. `diceTick.rolled` is the true die (the
      // before→after delta under-reports it when the roll floors at 1).
      const rolled = step.diceTick?.rolled;
      return rolled != null
        ? `${played} — ${t} subtracts ${rolled} from their roll`
        : `${played} — ${t} subtracts a die from their roll`;
    }
    case "flat_modifier":
    case "dice_modifier":
      return `${played} on ${t}`;
    case "modifier_multiplier":
      return `${played} — ${t}'s modifier is multiplied`;
    case "set_modifier":
      return `${played} — ${t}'s modifier is set`;
    case "lowest_gains_highest_modifier":
      return `${played} — ${t} takes the table's highest modifier`;
    case "persistent_modifier_transfer":
      return `${played} — ${t}'s modifier changes for the rest of the day`;
    case "persistent_modifier_spend":
      return `${played} — ${t} spends modifier`;
    case "contested_negate": {
      const base = `${played} to counter ${t}'s effect`;
      if (step.contest && (step.contest.d20 != null || step.contest.dc != null)) {
        return `${base} (rolled ${fmt(step.contest.d20)} vs DC ${fmt(step.contest.dc)})`;
      }
      return base;
    }
    case "redirect":
      return `${played} — the effect is redirected to ${t}`;
    case "roll_exemption":
      // Issue #433: a Roll Exemption (Loaf of Lipton) -- the player has no
      // layer-0 die this round, and this says why.
      return `${t} skipped their roll — ${k || "Roll Exemption"}`;
    case "roll_frozen":
      // Issue #351: on a Time for Brew replay, a negative-polarity roll-domain
      // ward holder keeps their generation-0 roll — no source cast on the step.
      return `${t}'s roll is held by a roll-domain ward — no reroll on replay`;
    case "warded": {
      const wardName = step.ward?.wardCardName ?? "A ward";
      if (!k) return `${wardName} wards ${t} — no modifier gained as brewer`;
      return `${wardName} wards ${t} — ${k} is blocked`;
    }
    case "targeting_skip":
      // Issue #321: Cloud of Cream — the holder is passed over for
      // highest/lowest-modifier target selection; the substituted player gets
      // their own lift / brewer step, so the skip needs no target here.
      return `${k || "Cloud of Cream"} — ${t} is skipped for highest/lowest-modifier targeting`;
    case "brewer_immunity": {
      // Issue #428: The Last Cuppa (ADR 0005 tier 0) — an immune player is
      // skipped at whichever tier would have named them.
      const card = k || "Brewer immunity";
      const skipped = step.immunity?.skippedCardName;
      switch (step.immunity?.tier) {
        case "declared_number":
          return `${card} — ${t} rolled the number declared by ${skipped ?? "a card"} but can't be Tea Maker`;
        case "tea_maker_override":
          return `${card} — ${skipped ?? "the override"} can't make ${t} brew`;
        case "all_immune":
          return step.after.value === "tie"
            ? "Every Participant is immune — immunity gives way to a Tie-Break Reroll"
            : "Every Participant is immune — immunity gives way";
        case "lowest_roller":
        default:
          return `${card} — ${t} rolled lowest but can't be Tea Maker; the next-lowest roll brews`;
      }
    }
    case "earl_transfer":
      // Issue #429: forcing tea on the Earl passes the title to the forcing
      // card's caster; the override's own step then says the ex-Earl brews.
      return `${k || "Earl of Earl Grey"} — ${step.earlTransfer?.forcingCardName ?? "a card"} forces tea on ${t}, so the Earl title passes to ${names.newEarl}`;
    case "named_tea_maker_rolloff":
      // Issue #431: Loose Leaf -- the named holder rolls off against every
      // roller tied at second-lowest, or the card does nothing without one.
      return names.rolloffOpponents.length > 0
        ? `${played} — ${t} is named Tea Maker, so ${joinNames([t, ...names.rolloffOpponents], "")} roll off; the ${names.rolloffOpponents.length > 1 ? "lowest" : "lower"} roll brews`
        : `${played} — no effect: there's no second-lowest roller to roll off against`;
    case "brew_debt":
      // Issue #432: Brew IOU named the Tea Maker, so its caster owes a Brew
      // Debt (after "owes"); or this round paid one (after "brewer"). The
      // paying round's step points at the Brew IOU cast of an earlier round.
      return step.after.value === "owes"
        ? `${k || "Brew IOU"} — ${t} owes a Brew Debt: they make tea in their next round, no roll`
        : `${k || "Brew IOU"} — ${t} pays their Brew Debt and makes tea; nobody rolls`;
    case "declared_number_tea_maker":
      return `${k || "Declared number"}: ${t} rolled the declared number and brews`;
    case "tea_maker_override": {
      // Issue #427: PG Tipped's condition failed -- the cast drops out of the
      // override contest and selection falls through.
      const cond = step.failedOverrideCondition;
      if (cond) {
        const rolls =
          cond.targetRoll != null && cond.casterRoll != null
            ? `: ${t} rolled ${cond.targetRoll}, not lower than ${c}'s ${cond.casterRoll}`
            : "";
        return `${played} on ${t} — condition not met${rolls}, so it doesn't pick the brewer`;
      }
      // Issue #426: an inert Last Drip says why it did nothing.
      if (step.overrideReason) return `${played} — no effect: ${OVERRIDE_NOOP_TEXT[step.overrideReason](t)}`;
      // Issue #430: Tea Party Revolt names who picked.
      if (names.pickedBy) return `${played} — ${names.pickedBy}, the lowest roller, picks ${t} to brew`;
      const noGain = String(step.after.value ?? "").includes("no modifier");
      return `${played} — ${t} brews${noGain ? " (no modifier gain)" : ""}`;
    }
    case "compel_cast":
      // Issue #440: Brewmageddon names its compelled set, or did nothing.
      return names.compelled.length > 0
        ? `${played} — ${joinNames(names.compelled, "")} must play their card`
        : `${played} — nobody held a card`;
    case "forfeit": {
      const reason = step.compel?.reason;
      const why = reason ? FORFEIT_REASON_TEXT[reason] : null;
      return `${t}'s ${k} is forfeited to ${names.compelledBy}${why ? ` — ${why}` : ""}`;
    }
    case "card_heist": {
      // Issue #438: Tea Heist. The stolen card is never named — a held card
      // is private to its holder.
      const heistOutcome = String(step.after.value ?? "");
      if (heistOutcome === HEIST_MOVED) return `${played} — ${c} steals ${t}'s card`;
      if (heistOutcome === HEIST_COUNTERED) return `${played} on ${t} — countered, the card stays with ${t}`;
      if (step.heistReason === "thief_hand_full") return `${played} on ${t} — fizzled: ${c}'s hand is full`;
      return `${played} on ${t} — fizzled: ${t} played the card first`;
    }
    case "draw_redirect": {
      // Issue #436: Marked for Brew. The mark's caster is the beneficiary; a
      // fired step's cast is usually from an earlier round.
      const markOutcome = String(step.after.value ?? "");
      const card = k || "Marked for Brew";
      // Issue #437: Stale Biscuit fires at draw time, after its round's Trace
      // is written, so only its `marked` step ever appears.
      if (markOutcome === MARK_PLACED && step.redirectTrigger === "next_draw") {
        return `${played} — ${t} is marked: the next card ${t} draws goes to ${c}`;
      }
      if (markOutcome === MARK_PLACED) {
        return `${played} — ${t} is marked: ${c} draws the card for ${t}'s next nat 1 or nat 20 within 5 rounds`;
      }
      if (markOutcome === MARK_FIZZLED) {
        return `${card} — fizzled: ${c} already has a card to draw this round, so ${t} draws their own`;
      }
      return `${card} — ${t} rolled a nat 1 or nat 20, so ${c} draws the card instead`;
    }
    default:
      return k ? `${played} on ${t}` : humanKind(step.displayKind);
  }
}

function statusFor(step: ResolutionTraceStep): { label: string; kind: CastState } {
  if (step.negated) return { label: "negated", kind: "negated" };
  // Issue #351: `roll_frozen` is a before === after step — the roll was held,
  // not moved — so it shares the muted "no-op" styling; the "frozen" label and
  // the sentence carry why.
  if (step.displayKind === "roll_frozen") return { label: "frozen", kind: "no-op" };
  // Issue #433: the missing die is the effect.
  if (step.displayKind === "roll_exemption") return { label: "skipped", kind: "applied" };
  // Issue #440: a Forfeit is a no-effect step; the label says what happened.
  if (step.displayKind === "forfeit") return { label: "forfeited", kind: "no-op" };
  if (step.displayKind === "contested_negate" && step.after.type === "status") {
    const v = String(step.after.value ?? "");
    if (v === CONTEST_BACKFIRED) return { label: "backfired", kind: "backfired" };
    if (v === CONTEST_COUNTERED) return { label: "countered", kind: "negated" };
    if (v === CONTEST_NO_EFFECT) return { label: "no effect", kind: "no-op" };
    return { label: v || "applied", kind: "applied" };
  }
  // Issue #427: a failed PG Tipped condition.
  if (step.failedOverrideCondition) return { label: "condition not met", kind: "no-op" };
  if (step.displayKind === "card_heist") {
    const v = String(step.after.value ?? "");
    if (v === HEIST_MOVED) return { label: "moved", kind: "applied" };
    if (v === HEIST_FIZZLED) return { label: "fizzled", kind: "no-op" };
    if (v === HEIST_COUNTERED) return { label: "countered", kind: "negated" };
  }
  if (step.displayKind === "draw_redirect") {
    const v = String(step.after.value ?? "");
    if (v === MARK_PLACED) return { label: "marked", kind: "applied" };
    if (v === MARK_REDIRECTED) return { label: "redirected", kind: "applied" };
    if (v === MARK_FIZZLED) return { label: "fizzled", kind: "no-op" };
  }
  switch (step.outcome) {
    case "backfired":
      return { label: "backfired", kind: "backfired" };
    case "blocked":
      return { label: "blocked", kind: "blocked" };
    case "no-op":
      return { label: "no effect", kind: "no-op" };
    default:
      return { label: "applied", kind: "applied" };
  }
}

function phaseForStep(step: ResolutionTraceStep, castById: Map<string, RoundRecapCast>): PhaseLabel {
  if (OUTCOME_KINDS.has(step.displayKind)) return "Outcome";
  // A ward on the brewer's tea gain is a status→status step with no source card.
  if (step.displayKind === "warded" && step.before.type === "status") return "Outcome";

  const cast = step.sourceCast.castId ? castById.get(step.sourceCast.castId) : undefined;
  if (cast) return cast.phase === "reaction" ? "Reaction window" : "Before the roll";

  // Cast-less steps: a negated victim was struck by a reaction; anything else
  // (a carried-forward active effect) belongs before the roll.
  if (step.negated) return "Reaction window";
  return "Before the roll";
}

/** Resolved-mode cast state, from the cast's own trace steps + RPC flags. */
function resolvedCastState(cast: RoundRecapCast, steps: ResolutionTraceStep[]): CastState {
  if (cast.negated) return "negated";
  if (cast.redirectedToCastId) return "redirected";

  const own = steps.filter((s) => s.sourceCast.castId === cast.castId);
  if (own.some((s) => s.outcome === "backfired" || s.backfire)) return "backfired";
  if (own.some((s) => s.outcome === "blocked")) return "blocked";
  if (own.some((s) => s.outcome === "applied")) return "applied";
  // No applied step (or no step at all): the cast changed nothing the
  // resolver recorded.
  return "no-op";
}

const SKIP_REASON_TEXT: Record<ReactionSkip["reason"], string> = {
  vote: "skipped by vote",
  timeout: "timed out after 5 minutes",
};

/**
 * Issue #411: the Recap's "not heard from" line — the players the reaction
 * window stopped waiting on (skipped by vote, or timed out). It goes after the
 * last Reaction window step (the window closed once the reactions were in),
 * else before the first Outcome step.
 */
function insertReactionSkips(
  steps: Array<RecapStep & { phase: PhaseLabel }>,
  skips: ReactionSkip[],
  displayName: (playerId: string) => string,
): Array<RecapStep & { phase: PhaseLabel }> {
  if (skips.length === 0) return steps;

  const reasons = [...new Set(skips.map((s) => s.reason))];
  const sentence = reasons
    .map((reason) => {
      const names = skips.filter((s) => s.reason === reason).map((s) => displayName(s.playerId));
      return `${joinNames(names, "")}: ${SKIP_REASON_TEXT[reason]}`;
    })
    .join("; ");
  const line: RecapStep & { phase: PhaseLabel } = {
    phase: "Reaction window",
    displayIndex: "",
    castId: null,
    displayKind: "not_heard_from",
    sentence: `Not heard from ${sentence}`,
    targetPlayer: null,
    casterPlayerId: null,
    beforeAfter: null,
    statusLabel: reasons.length === 1 && reasons[0] === "timeout" ? "timed out" : "skipped",
    statusKind: "no-op",
    pending: false,
  };

  const lastReaction = steps.map((s) => s.phase).lastIndexOf("Reaction window");
  const firstOutcome = steps.findIndex((s) => s.phase === "Outcome");
  const at = lastReaction >= 0 ? lastReaction + 1 : firstOutcome >= 0 ? firstOutcome : steps.length;
  return [...steps.slice(0, at), line, ...steps.slice(at)];
}

/** Walk an ordered step list into contiguous same-phase groups. */
function groupByPhase(steps: Array<RecapStep & { phase: PhaseLabel }>): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.label === step.phase) {
      last.steps.push(step);
    } else {
      groups.push({ label: step.phase, steps: [step] });
    }
  }
  return groups;
}

export function buildRoundRecap({
  data,
  displayName,
  traceOnly = false,
}: BuildRoundRecapArgs): RoundRecapModel {
  // Issue #409: a provisional recap has a Trace (the resolver's dry run), so
  // it renders steps like a resolved one — labelled "so far" by the
  // component, and never announcing a tie (endedInTieBreak stays false: the
  // round's layerZeroOutcome is null until it really resolves).
  const live = !data.resolved && !data.provisional;
  const casts = [...data.casts].sort((a, b) => a.seq - b.seq);

  // A scrapped replay generation (issue #352) has a Resolution Trace but no
  // cast list — the scrap deleted its spell_casts. Every Trace step embeds its
  // own source card + caster, so the step rows still render; only the
  // tap-to-filter cast strip is absent.
  // Issue #432: a debt round has no casts of its own -- its one step (the
  // Brew Debt paid) is the whole story, so it renders from the Trace too.
  // Issue #436: likewise a round where an earlier round's Marked for Brew
  // mark fired.
  const traceDriven =
    !live &&
    casts.length === 0 &&
    data.trace.length > 0 &&
    (traceOnly || data.trace.some((s) => TRACE_ONLY_KINDS.has(s.displayKind)));
  const rows = buildRows(data, displayName);

  if (casts.length === 0 && !traceDriven && data.reactionSkips.length === 0) {
    return {
      hasContent: false,
      castStrip: [],
      phases: [],
      showReorderCaption: false,
      endedInTieBreak: false,
      rows,
      provisional: data.provisional,
    };
  }

  const castById = new Map(casts.map((c) => [c.castId, c]));

  // Issue #440: the card that compelled a cast (Brewmageddon), by cast id.
  const compelledByOf = (castId: string | null): string | undefined => {
    const compelledByCastId = castId ? castById.get(castId)?.compelledByCastId : null;
    if (!compelledByCastId) return undefined;
    return castById.get(compelledByCastId)?.cardName ?? BREWMAGEDDON;
  };
  const compelledSuffix = (compelledBy: string | undefined) =>
    compelledBy ? ` (compelled by ${compelledBy})` : "";

  // ---- Cast strip -------------------------------------------------------
  const castStrip: CastChip[] = casts.map((c) => {
    const compelledBy = compelledByOf(c.castId);
    return {
      castId: c.castId,
      cardName: c.cardName,
      casterName: displayName(c.casterPlayerId),
      state: live
        ? c.onStack
          ? "on-stack"
          : "armed"
        : resolvedCastState(c, data.trace),
      ...(compelledBy ? { compelledBy } : {}),
    };
  });

  // ---- Ordered step rows (resolution order / cast order) ----------------
  const ordered: Array<RecapStep & { phase: PhaseLabel }> = live
    ? casts
        .filter((c) => !c.targetPending)
        .map((c) => {
          const cName = displayName(c.casterPlayerId);
          const t = c.targetPlayerId ? displayName(c.targetPlayerId) : "the table";
          const compelledBy = compelledByOf(c.castId);
          const sentence =
            c.effectKind === "forfeit"
              ? `${cName} forfeited ${c.cardName} to ${compelledBy ?? BREWMAGEDDON}`
              : `${cName} played ${c.cardName}${c.targetPlayerId ? ` on ${t}` : ""}${compelledSuffix(compelledBy)}`;
          return {
            phase: c.phase === "reaction" ? "Reaction window" : "Before the roll",
            displayIndex: "·",
            castId: c.castId,
            displayKind: c.effectKind ?? "spell",
            sentence,
            targetPlayer: c.targetPlayerId,
            casterPlayerId: c.casterPlayerId,
            beforeAfter: null,
            statusLabel: "on stack",
            statusKind: "pending",
            pending: true,
          };
        })
    : data.trace.map((step, i) => {
        const t = step.targetPlayer ? displayName(step.targetPlayer) : "the table";
        const cName = step.sourceCast.casterPlayerId
          ? displayName(step.sourceCast.casterPlayerId)
          : "";
        const k = step.sourceCast.cardName ?? "";
        const status = statusFor(step);
        const beforeAfter: BeforeAfter | null =
          step.before.type === "status"
            ? null
            : {
                label: pillLabel(step.before.type),
                from: fmt(step.before.value),
                to: fmt(step.after.value),
                unchanged: step.before.value === step.after.value,
              };
        // Issue #440: a compelled cast's own steps say so; a Forfeit's
        // sentence already names what compelled it.
        const compelledBy = compelledByOf(step.sourceCast.castId);
        const sentence = sentenceFor(step, {
          t,
          c: cName,
          k,
          compelled: (step.compel?.compelledPlayerIds ?? []).map(displayName),
          compelledBy: compelledBy ?? BREWMAGEDDON,
          pickedBy: step.pickedBy ? displayName(step.pickedBy) : null,
          newEarl: step.earlTransfer ? displayName(step.earlTransfer.newEarlPlayerId) : "",
          rolloffOpponents: step.rolloffOpponents.map(displayName),
        });
        return {
          phase: phaseForStep(step, castById),
          displayIndex: String(i + 1),
          castId: step.sourceCast.castId,
          displayKind: step.displayKind,
          sentence: step.displayKind === "forfeit" ? sentence : sentence + compelledSuffix(compelledBy),
          targetPlayer: step.targetPlayer,
          casterPlayerId: step.sourceCast.casterPlayerId,
          beforeAfter,
          statusLabel: status.label,
          statusKind: status.kind,
          pending: false,
        };
      });

  const withSkips = insertReactionSkips(ordered, data.reactionSkips, displayName);

  return {
    hasContent: true,
    castStrip,
    // Issue #409: a provisional dry run never names a brewer — its Outcome
    // steps (declared number, tea-maker override, the brewer-gain ward, a
    // targeting skip) wait for the real resolution.
    phases: groupByPhase(data.provisional ? withSkips.filter((s) => s.phase !== "Outcome") : withSkips),
    showReorderCaption: !live && castStrip.length > 1,
    // Issue #431: a Loose Leaf roll-off also goes on to a later Layer, but
    // its own step explains that -- it isn't a tie for lowest.
    endedInTieBreak:
      !live && !data.provisional && data.layerZeroOutcome === "tie" && !data.trace.some((s) => s.rolloffOpponents.length > 0),
    rows,
    provisional: data.provisional,
  };
}

/**
 * One player's layer-0 row inside a scrapped generation's disclosure (issue
 * #352) — their first-attempt roll plus the reroll chain they were tied into,
 * all resolved so the renderer only lays it out.
 */
export type ScrappedGenerationRollRow = {
  playerId: string;
  /**
   * Issue #408: the row model from this generation's own Resolution Summary
   * and Trace (degraded when it has no summary) — never generation 1's.
   */
  row: RollRow;
  isBrewer: boolean;
  rerollChain: RerollChainLevel[];
};

export type ScrappedGenerationRecap = {
  generation: number;
  brewerId: string | null;
  cupsMade: number | null;
  brewerModifierGain: number | null;
  /** The generation's own Recap ledger, built from its Trace alone (no cast strip). */
  recap: RoundRecapModel;
  /**
   * The generation's layer-0 rolls in display order (roster first, then any
   * roller not on the roster), each with its own reroll chain — the #220
   * nested rows, kept separate from generation 1's own layers.
   */
  firstAttemptRolls: ScrappedGenerationRollRow[];
  /** true when the generation was decided by a tie-break rather than at layer 0. */
  wentToTieBreak: boolean;
};

/**
 * Issue #352: turn one retained scrapped replay generation into everything the
 * collapsed generation-0 disclosure renders — its own Round Recap ledger (from
 * the Trace, no cast strip) and its layer-0 rolls with their tie-break reroll
 * chains, ordered by `roster`. All model work lives here; the component only
 * lays the result out.
 */
export function buildScrappedGenerationRecap(
  gen: ScrappedGeneration,
  displayName: (playerId: string) => string,
  roster: string[] = [],
): ScrappedGenerationRecap {
  const wentToTieBreak = gen.layers.some((l) => l.layer > 0);
  const recap = buildRoundRecap({
    data: {
      resolved: true,
      layerZeroOutcome: wentToTieBreak ? "tie" : "brewer",
      trace: gen.trace,
      casts: [],
      scrappedGenerations: [],
      summary: gen.summary,
      provisional: false,
      layers: gen.layers,
      layerParticipants: gen.layerParticipants,
      reactionSkips: [],
    },
    displayName,
    traceOnly: true,
  });

  const layerZeroRolls = gen.layers.find((l) => l.layer === 0)?.rolls ?? [];
  const rollByPlayer = new Map(layerZeroRolls.map((r) => [r.playerId, r]));
  // Roster (generation 1's participant order) first for the familiar ordering,
  // then any generation-0-only roller — a gen-0 late-declare or a proxy for
  // someone absent by gen 1 — in that generation's own snapshotted order, then
  // any straggler. So a roll is never dropped and gen-0-only rollers keep a
  // stable place rather than sorting arbitrarily.
  const gen0Order = gen.layerParticipants.filter((lp) => lp.layer === 0).map((lp) => lp.playerId);
  const orderedPlayerIds = [
    ...roster.filter((id) => rollByPlayer.has(id)),
    ...gen0Order.filter((id) => rollByPlayer.has(id) && !roster.includes(id)),
    ...layerZeroRolls
      .map((r) => r.playerId)
      .filter((id) => !roster.includes(id) && !gen0Order.includes(id)),
  ];
  const rowByPlayer = new Map(recap.rows.map((r) => [r.playerId, r]));
  const firstAttemptRolls: ScrappedGenerationRollRow[] = orderedPlayerIds.flatMap((playerId) => {
    const row = rowByPlayer.get(playerId);
    if (!row) return [];
    return [
      {
        playerId,
        row,
        isBrewer: gen.brewerId === playerId,
        rerollChain: buildRerollChain(playerId, gen.layers, gen.layerParticipants),
      },
    ];
  });

  return {
    generation: gen.generation,
    brewerId: gen.brewerId,
    cupsMade: gen.cupsMade,
    brewerModifierGain: gen.brewerModifierGain,
    recap,
    firstAttemptRolls,
    wentToTieBreak,
  };
}
