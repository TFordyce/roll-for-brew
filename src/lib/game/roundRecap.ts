import type { RoundRecapCast, RoundRecapData, ScrappedGeneration } from "@/lib/supabase/roundRecap";
import type { ResolutionTraceStep } from "@/lib/supabase/rolls";
import { buildRerollChain, type RerollChainLevel } from "@/lib/game/rerollChain";

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
 * Two rendering modes:
 *  - resolved: steps come from the Trace, in resolution order, numbered.
 *  - live (round closed, not yet resolved): there is no Trace, so pending
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

const OUTCOME_KINDS = new Set(["declared_number_tea_maker", "tea_maker_override"]);

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
function sentenceFor(step: ResolutionTraceStep, names: { t: string; c: string; k: string }): string {
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
    case "roll_frozen":
      // Issue #351: on a Time for Brew replay, a negative-polarity roll-domain
      // ward holder keeps their generation-0 roll — no source cast on the step.
      return `${t}'s roll is held by a roll-domain ward — no reroll on replay`;
    case "warded": {
      const wardName = step.ward?.wardCardName ?? "A ward";
      if (!k) return `${wardName} wards ${t} — no modifier gained as brewer`;
      return `${wardName} wards ${t} — ${k} is blocked`;
    }
    case "declared_number_tea_maker":
      return `${k || "Declared number"}: ${t} rolled the declared number and brews`;
    case "tea_maker_override": {
      const noGain = String(step.after.value ?? "").includes("no modifier");
      return `${played} — ${t} brews${noGain ? " (no modifier gain)" : ""}`;
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
  if (step.displayKind === "contested_negate" && step.after.type === "status") {
    const v = String(step.after.value ?? "");
    if (v === CONTEST_BACKFIRED) return { label: "backfired", kind: "backfired" };
    if (v === CONTEST_COUNTERED) return { label: "countered", kind: "negated" };
    if (v === CONTEST_NO_EFFECT) return { label: "no effect", kind: "no-op" };
    return { label: v || "applied", kind: "applied" };
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
  const live = !data.resolved;
  const casts = [...data.casts].sort((a, b) => a.seq - b.seq);

  // A scrapped replay generation (issue #352) has a Resolution Trace but no
  // cast list — the scrap deleted its spell_casts. Every Trace step embeds its
  // own source card + caster, so the step rows still render; only the
  // tap-to-filter cast strip is absent.
  const traceDriven = traceOnly && !live && casts.length === 0 && data.trace.length > 0;

  if (casts.length === 0 && !traceDriven) {
    return {
      hasContent: false,
      castStrip: [],
      phases: [],
      showReorderCaption: false,
      endedInTieBreak: false,
    };
  }

  const castById = new Map(casts.map((c) => [c.castId, c]));

  // ---- Cast strip -------------------------------------------------------
  const castStrip: CastChip[] = casts.map((c) => ({
    castId: c.castId,
    cardName: c.cardName,
    casterName: displayName(c.casterPlayerId),
    state: live
      ? c.onStack
        ? "on-stack"
        : "armed"
      : resolvedCastState(c, data.trace),
  }));

  // ---- Ordered step rows (resolution order / cast order) ----------------
  const ordered: Array<RecapStep & { phase: PhaseLabel }> = live
    ? casts
        .filter((c) => !c.targetPending)
        .map((c) => {
          const cName = displayName(c.casterPlayerId);
          const t = c.targetPlayerId ? displayName(c.targetPlayerId) : "the table";
          return {
            phase: c.phase === "reaction" ? "Reaction window" : "Before the roll",
            displayIndex: "·",
            castId: c.castId,
            displayKind: c.effectKind ?? "spell",
            sentence: `${cName} played ${c.cardName}${c.targetPlayerId ? ` on ${t}` : ""}`,
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
        return {
          phase: phaseForStep(step, castById),
          displayIndex: String(i + 1),
          castId: step.sourceCast.castId,
          displayKind: step.displayKind,
          sentence: sentenceFor(step, { t, c: cName, k }),
          targetPlayer: step.targetPlayer,
          casterPlayerId: step.sourceCast.casterPlayerId,
          beforeAfter,
          statusLabel: status.label,
          statusKind: status.kind,
          pending: false,
        };
      });

  return {
    hasContent: true,
    castStrip,
    phases: groupByPhase(ordered),
    showReorderCaption: !live && castStrip.length > 1,
    endedInTieBreak: !live && data.layerZeroOutcome === "tie",
  };
}

/**
 * One player's layer-0 row inside a scrapped generation's disclosure (issue
 * #352) — their first-attempt roll plus the reroll chain they were tied into,
 * all resolved so the renderer only lays it out.
 */
export type ScrappedGenerationRollRow = {
  playerId: string;
  value: number;
  modifierSnapshot: number;
  discardedValue: number | null;
  enteredByAdmin: boolean;
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
  const firstAttemptRolls: ScrappedGenerationRollRow[] = orderedPlayerIds.map((playerId) => {
    const roll = rollByPlayer.get(playerId)!;
    return {
      playerId,
      value: roll.value,
      modifierSnapshot: roll.modifierSnapshot,
      discardedValue: roll.discardedValue,
      enteredByAdmin: roll.enteredByAdmin,
      isBrewer: gen.brewerId === playerId,
      rerollChain: buildRerollChain(playerId, gen.layers),
    };
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
