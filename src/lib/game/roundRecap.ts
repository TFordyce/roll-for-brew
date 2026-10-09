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
import { passedOverClause } from "@/lib/game/lastDrip";

export type RerollChainLevel = {
  layer: number;
  roll: number;
  modifier: number;
  nat: "nat1" | "nat20" | null;
  badgeValue: number;
  tied: boolean;
};

function tieLayerStanding(roll: number, modifier: number): { nat: "nat1" | "nat20" | null; badgeValue: number } {
  const calc = classifyRollCalculation(roll, modifier);
  return calc.kind === "sum" ? { nat: null, badgeValue: calc.total } : { nat: calc.kind, badgeValue: roll };
}

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
  compelledBy?: string;
};

export type BeforeAfter = {
  label: string;
  from: string;
  to: string;
  unchanged: boolean;
};

export type RecapStep = {
  displayIndex: string;
  castId: string | null;
  displayKind: string;
  sentence: string;
  targetPlayer: string | null;
  casterPlayerId: string | null;
  beforeAfter: BeforeAfter | null;
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
  hasContent: boolean;
  castStrip: CastChip[];
  phases: PhaseGroup[];
  showReorderCaption: boolean;
  endedInTieBreak: boolean;
  rows: RollRow[];
  provisional: boolean;
};

export type RollRowTerm = {
  displayKind: string;
  domain: "roll" | "modifier" | "status";
  cardName: string | null;
  casterName: string | null;
  from: number | null;
  to: number | null;
  delta: number | null;
  struck: "warded" | "negated" | "redirected" | null;
  restOfDay: boolean;
  pending: boolean;
};

export type RollRow = {
  playerId: string;
  roll: number;
  discardedRoll: number | null;
  enteredByAdmin: boolean;
  snapshot: number;
  composed: number | null;
  total: number | null;
  nat: "nat1" | "nat20" | null;
  diceReduced: boolean;
  badgeValue: number | null;
  terms: RollRowTerm[];
  provisional: boolean;
  degraded: boolean;
};

export type BuildRoundRecapArgs = {
  data: RoundRecapData;
  displayName: (playerId: string) => string;
  traceOnly?: boolean;
};

const CONTEST_COUNTERED = "countered";
const CONTEST_BACKFIRED = "backfired";
const CONTEST_NO_EFFECT = "no effect";

const OUTCOME_KINDS = new Set([
  "declared_number_tea_maker",
  "tea_maker_override",
  "targeting_skip",
  "brewer_immunity",
  "earl_transfer",
  "named_tea_maker_rolloff",
  "card_heist",
  "brew_debt",
  "draw_redirect",
]);

const TRACE_ONLY_KINDS = new Set(["brew_debt", "draw_redirect"]);

const BREWMAGEDDON = "Brewmageddon";

const FORFEIT_REASON_TEXT: Record<ForfeitReason, string> = {
  no_legal_target: "it had no legal target",
  stall: "they never played it",
  excluded: "they never rolled",
  vote: "they were skipped by vote",
  timeout: "they timed out",
};
const OVERRIDE_NOOP_TEXT: Record<OverrideNoopReason, (target: string) => string> = {
  no_previous_round: () => "there's no previous round",
  no_eligible_roller: () => "nobody from the previous round can make tea",
  target_absent: (t) => `${t} isn't in this round`,
  condition_not_met: () => "its condition wasn't met",
  pick_abandoned: () => "the lowest roller never picked who brews",
  pick_pending: () => "the lowest roller hasn't picked yet",
};
const HEIST_MOVED = "moved";
const HEIST_FIZZLED = "fizzled";
const HEIST_COUNTERED = "countered";
const MARK_PLACED = "marked";
const MARK_REDIRECTED = "redirected";
const MARK_FIZZLED = "fizzled";

function numeric(value: number | string | null): number | null {
  return typeof value === "number" ? value : null;
}

function termsFor(
  playerId: string,
  trace: ResolutionTraceStep[],
  displayName: (playerId: string) => string,
): RollRowTerm[] {
  const terms: RollRowTerm[] = [];
  for (const step of trace) {
    const cardName = step.sourceCast.cardName;
    const casterName = step.sourceCast.casterPlayerId ? displayName(step.sourceCast.casterPlayerId) : null;

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

function pillLabel(type: string): string {
  if (type === "roll") return "roll";
  if (type === "modifier") return "mod";
  return "";
}

function fmt(value: number | string | null): string {
  if (value === null) return "—";
  return String(value);
}

function sentenceFor(
  step: ResolutionTraceStep,
  names: {
    t: string;
    c: string;
    k: string;
    compelled: string[];
    compelledBy: string;
    pickedBy: string | null;
    newEarl: string;
    rolloffOpponents: string[];
    passedOver: string;
  },
): string {
  const { t, c, k } = names;
  const played = k ? `${c} played ${k}` : c;

  if (step.negated && step.displayKind !== "contested_negate") {
    return `${t}'s ${humanKind(step.displayKind)} was negated`;
  }

  switch (step.displayKind) {
    case "advantage":
      return `${played} — ${t} rolls with advantage`;
    case "disadvantage":
      return `${played} — ${t} rolls with disadvantage`;
    case "conditional_advantage":
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
      if (step.pairOp === "min") return `${played} — ${t} takes the lower of the linked pair`;
      if (step.pairOp === "max") return `${played} — ${t} takes the higher of the linked pair`;
      return `${played} — ${t}'s die is swapped with the linked player`;
    case "fixed_roll":
      return `${played} — ${t}'s die is fixed`;
    case "dice_tick": {
      const rolled = step.diceTick?.rolled;
      return rolled != null
        ? `${played} — ${t} subtracts ${rolled} from their roll`
        : `${played} — ${t} subtracts a die from their roll`;
    }
    case "flat_modifier":
    case "dice_modifier":
      if (step.courageToken) {
        const added = Number(step.after.value) - Number(step.before.value);
        return `${t} spent a Courage Token${k ? ` (${k})` : ""} — +${added} to their roll`;
      }
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
      return `${t} skipped their roll — ${k || "Roll Exemption"}`;
    case "roll_frozen":
      return `${t}'s roll is held by a roll-domain ward — no reroll on replay`;
    case "warded": {
      const wardName = step.ward?.wardCardName ?? "A ward";
      if (!k) return `${wardName} wards ${t} — no modifier gained as brewer`;
      return `${wardName} wards ${t} — ${k} is blocked`;
    }
    case "targeting_skip":
      return `${k || "Cloud of Cream"} — ${t} is skipped for highest/lowest-modifier targeting`;
    case "brewer_immunity": {
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
      return `${k || "Earl of Earl Grey"} — ${step.earlTransfer?.forcingCardName ?? "a card"} forces tea on ${t}, so the Earl title passes to ${names.newEarl}`;
    case "named_tea_maker_rolloff":
      return names.rolloffOpponents.length > 0
        ? `${played} — ${t} is named Tea Maker, so ${joinNames([t, ...names.rolloffOpponents], "")} roll off; the ${names.rolloffOpponents.length > 1 ? "lowest" : "lower"} roll brews`
        : `${played} — no effect: there's no second-lowest roller to roll off against`;
    case "brew_debt":
      return step.after.value === "owes"
        ? `${k || "Brew IOU"} — ${t} owes a Brew Debt: they make tea in their next round, no roll`
        : `${k || "Brew IOU"} — ${t} pays their Brew Debt and makes tea; nobody rolls`;
    case "declared_number_tea_maker":
      return `${k || "Declared number"}: ${t} rolled the declared number and brews`;
    case "tea_maker_override": {
      const cond = step.failedOverrideCondition;
      if (cond) {
        const rolls =
          cond.targetRoll != null && cond.casterRoll != null
            ? `: ${t} rolled ${cond.targetRoll}, not lower than ${c}'s ${cond.casterRoll}`
            : "";
        return `${played} on ${t} — condition not met${rolls}, so it doesn't pick the brewer`;
      }
      if (step.overrideReason) {
        const why = OVERRIDE_NOOP_TEXT[step.overrideReason](t);
        return `${played} — no effect: ${why}${names.passedOver ? ` — ${names.passedOver}` : ""}`;
      }
      if (names.pickedBy) return `${played} — ${names.pickedBy}, the lowest roller, picks ${t} to brew`;
      const noGain = String(step.after.value ?? "").includes("no modifier");
      const brews = `brews${noGain ? " (no modifier gain)" : ""}`;
      if (names.passedOver) return `${played} — ${names.passedOver}, so it falls to ${t}, who ${brews}`;
      return `${played} — ${t} ${brews}`;
    }
    case "compel_cast":
      return names.compelled.length > 0
        ? `${played} — ${joinNames(names.compelled, "")} must play their card`
        : `${played} — nobody held a card`;
    case "forfeit": {
      const reason = step.compel?.reason;
      const why = reason ? FORFEIT_REASON_TEXT[reason] : null;
      return `${t}'s ${k} is forfeited to ${names.compelledBy}${why ? ` — ${why}` : ""}`;
    }
    case "card_heist": {
      const heistOutcome = String(step.after.value ?? "");
      if (heistOutcome === HEIST_MOVED) return `${played} — ${c} steals ${t}'s card`;
      if (heistOutcome === HEIST_COUNTERED) return `${played} on ${t} — countered, the card stays with ${t}`;
      if (step.heistReason === "thief_hand_full") return `${played} on ${t} — fizzled: ${c}'s hand is full`;
      return `${played} on ${t} — fizzled: ${t} played the card first`;
    }
    case "draw_redirect": {
      const markOutcome = String(step.after.value ?? "");
      const card = k || "Marked for Brew";
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
  if (step.displayKind === "roll_frozen") return { label: "frozen", kind: "no-op" };
  if (step.displayKind === "roll_exemption") return { label: "skipped", kind: "applied" };
  if (step.displayKind === "forfeit") return { label: "forfeited", kind: "no-op" };
  if (step.displayKind === "contested_negate" && step.after.type === "status") {
    const v = String(step.after.value ?? "");
    if (v === CONTEST_BACKFIRED) return { label: "backfired", kind: "backfired" };
    if (v === CONTEST_COUNTERED) return { label: "countered", kind: "negated" };
    if (v === CONTEST_NO_EFFECT) return { label: "no effect", kind: "no-op" };
    return { label: v || "applied", kind: "applied" };
  }
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
  if (step.displayKind === "warded" && step.before.type === "status") return "Outcome";

  const cast = step.sourceCast.castId ? castById.get(step.sourceCast.castId) : undefined;
  if (cast) return cast.phase === "reaction" ? "Reaction window" : "Before the roll";

  if (step.negated) return "Reaction window";
  return "Before the roll";
}

function resolvedCastState(cast: RoundRecapCast, steps: ResolutionTraceStep[]): CastState {
  if (cast.negated) return "negated";
  if (cast.redirectedToCastId) return "redirected";

  const own = steps.filter((s) => s.sourceCast.castId === cast.castId);
  if (own.some((s) => s.outcome === "backfired" || s.backfire)) return "backfired";
  if (own.some((s) => s.outcome === "blocked")) return "blocked";
  if (own.some((s) => s.outcome === "applied")) return "applied";
  return "no-op";
}

const SKIP_REASON_TEXT: Record<ReactionSkip["reason"], string> = {
  vote: "skipped by vote",
  timeout: "timed out after 5 minutes",
};

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
  const live = !data.resolved && !data.provisional;
  const casts = [...data.casts].sort((a, b) => a.seq - b.seq);

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

  const compelledByOf = (castId: string | null): string | undefined => {
    const compelledByCastId = castId ? castById.get(castId)?.compelledByCastId : null;
    if (!compelledByCastId) return undefined;
    return castById.get(compelledByCastId)?.cardName ?? BREWMAGEDDON;
  };
  const compelledSuffix = (compelledBy: string | undefined) =>
    compelledBy ? ` (compelled by ${compelledBy})` : "";

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
          passedOver: passedOverClause(step.passedOver, displayName),
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
    phases: groupByPhase(data.provisional ? withSkips.filter((s) => s.phase !== "Outcome") : withSkips),
    showReorderCaption: !live && castStrip.length > 1,
    endedInTieBreak:
      !live && !data.provisional && data.layerZeroOutcome === "tie" && !data.trace.some((s) => s.rolloffOpponents.length > 0),
    rows,
    provisional: data.provisional,
  };
}

export type ScrappedGenerationRollRow = {
  playerId: string;
  row: RollRow;
  isBrewer: boolean;
  rerollChain: RerollChainLevel[];
};

export type ScrappedGenerationRecap = {
  generation: number;
  brewerId: string | null;
  cupsMade: number | null;
  brewerModifierGain: number | null;
  recap: RoundRecapModel;
  firstAttemptRolls: ScrappedGenerationRollRow[];
  wentToTieBreak: boolean;
};

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
