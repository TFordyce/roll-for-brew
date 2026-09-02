import type { RoundRecapCast, RoundRecapData } from "@/lib/supabase/roundRecap";
import type { ResolutionTraceStep } from "@/lib/supabase/rolls";

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
    case "forced_reroll":
      return `${played} — ${t} must reroll`;
    case "roll_flip":
      return `${played} — ${t}'s die is flipped`;
    case "roll_swap":
      return `${played} — ${t}'s die is swapped`;
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
    case "roll-frozen":
      // Issue #351: a roll-domain ward holder's roll carried over on a Time
      // for Brew replay — no source cast, so `played` is unused.
      return `${t}'s roll is frozen by a roll-domain ward — no reroll on replay`;
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
  // Issue #351: `roll-frozen` is a before === after marker (6-arg _rr_trace_step
  // ⇒ outcome "no-op"), but it is not a zero-impact effect — the roll was held.
  if (step.displayKind === "roll-frozen") return { label: "frozen", kind: "applied" };
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

export function buildRoundRecap({ data, displayName }: BuildRoundRecapArgs): RoundRecapModel {
  const live = !data.resolved;
  const casts = [...data.casts].sort((a, b) => a.seq - b.seq);

  if (casts.length === 0) {
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
