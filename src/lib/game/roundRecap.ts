import type { RoundRecapCast, RoundRecapData } from "@/lib/supabase/roundRecap";
import type { ResolutionTraceStep } from "@/lib/supabase/rolls";

/**
 * The Round Recap ("the Ledger", issue #314) — a pure transform from a round's
 * Resolution Trace + cast list into the two things the UI draws: a tap-to-
 * filter cast strip, and a flat, phase-grouped list of step rows in resolution
 * order. This module owns exactly one sentence template per `display_kind`;
 * `RoundRecap.tsx` owns none.
 *
 * Two rendering modes:
 *  - resolved: steps come from the Trace, in resolution order, numbered.
 *  - live (round closed, not yet resolved): there is no Trace, so pending
 *    steps are synthesised from the cast list in cast order, indexed `·`, and
 *    shimmer. On resolve they re-sort to resolution order — never predicted
 *    client-side.
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
  cardName: string | null;
  casterName: string | null;
  targetPlayer: string | null;
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
   * Layer-0 resolver outcome when known (RoundReveal has it from the reveal
   * broadcast / tie phase). "tie" appends the tie-break note. Omit otherwise.
   */
  layerZeroOutcome?: "brewer" | "tie";
};

const PHASE_ORDER: PhaseLabel[] = ["Before the roll", "Reaction window", "Outcome"];

const OUTCOME_KINDS = new Set(["declared_number_tea_maker", "tea_maker_override"]);

const ROLL_INPUT_KINDS = new Set([
  "advantage",
  "disadvantage",
  "forced_reroll",
  "roll_flip",
  "roll_swap",
]);

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
      // A negated victim step (castId null, negated flag) carries the victim's
      // own effect_kind as displayKind.
      if (step.negated) return `${t}'s ${humanKind(step.displayKind)} was negated`;
      return k ? `${played} on ${t}` : humanKind(step.displayKind);
  }
}

function statusFor(step: ResolutionTraceStep): { label: string; kind: CastState } {
  if (step.negated) return { label: "negated", kind: "negated" };
  if (step.displayKind === "contested_negate" && step.after.type === "status") {
    const v = String(step.after.value ?? "");
    if (v === "backfired") return { label: "backfired", kind: "backfired" };
    if (v === "countered") return { label: "countered", kind: "negated" };
    if (v === "no effect") return { label: "no effect", kind: "no-op" };
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
  if (own.length > 0) return "no-op";
  // No step at all: the cast contributed nothing the resolver recorded.
  return "no-op";
}

export function buildRoundRecap({
  data,
  displayName,
  layerZeroOutcome,
}: BuildRoundRecapArgs): RoundRecapModel {
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

  // ---- Step rows ------------------------------------------------------
  const buckets = new Map<PhaseLabel, RecapStep[]>(PHASE_ORDER.map((l) => [l, []]));

  if (live) {
    // One pending row per cast that will produce a ledger step, in cast order.
    for (const c of casts) {
      if (c.targetPending) continue;
      const label: PhaseLabel = c.phase === "reaction" ? "Reaction window" : "Before the roll";
      const t = c.targetPlayerId ? displayName(c.targetPlayerId) : "the table";
      const cName = displayName(c.casterPlayerId);
      buckets.get(label)!.push({
        displayIndex: "·",
        castId: c.castId,
        displayKind: c.effectKind ?? "spell",
        sentence: `${cName} played ${c.cardName}${c.targetPlayerId ? ` on ${t}` : ""}`,
        cardName: c.cardName,
        casterName: cName,
        targetPlayer: c.targetPlayerId,
        beforeAfter: null,
        statusLabel: "on stack",
        statusKind: "pending",
        pending: true,
      });
    }
  } else {
    for (const step of data.trace) {
      const phase = phaseForStep(step, castById);
      const t = step.targetPlayer ? displayName(step.targetPlayer) : "the table";
      const cName = step.sourceCast.casterPlayerId
        ? displayName(step.sourceCast.casterPlayerId)
        : "";
      const k = step.sourceCast.cardName ?? "";
      const status = statusFor(step);

      const label = pillLabel(step.before.type);
      const beforeAfter: BeforeAfter | null =
        step.before.type === "status"
          ? null
          : {
              label,
              from: fmt(step.before.value),
              to: fmt(step.after.value),
              unchanged: step.before.value === step.after.value,
            };

      buckets.get(phase)!.push({
        displayIndex: "",
        castId: step.sourceCast.castId,
        displayKind: step.displayKind,
        sentence: sentenceFor(step, { t, c: cName, k }),
        cardName: step.sourceCast.cardName,
        casterName: cName || null,
        targetPlayer: step.targetPlayer,
        beforeAfter,
        statusLabel: status.label,
        statusKind: status.kind,
        pending: false,
      });
    }
  }

  const phases: PhaseGroup[] = PHASE_ORDER.map((label) => ({
    label,
    steps: buckets.get(label)!,
  })).filter((g) => g.steps.length > 0);

  // Number resolved steps 1..n across the flattened phase order.
  if (!live) {
    let n = 0;
    for (const g of phases) {
      for (const s of g.steps) {
        n += 1;
        s.displayIndex = String(n);
      }
    }
  }

  return {
    hasContent: true,
    castStrip,
    phases,
    showReorderCaption: !live && castStrip.length > 1,
    endedInTieBreak: !live && layerZeroOutcome === "tie",
  };
}
