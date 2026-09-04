// Trace-snapshot harness — shared framework (issue #366, map #350 slice S1).
//
// A permanent, sub-round regression net for resolve_round(uuid): a curated
// corpus of freshly-seeded rounds, each resolved once, its Resolution Trace
// normalised and written to a committed golden file. Every integration run
// diffs live output against the goldens; `vitest -u` refreshes them.
//
// WHY NORMALISE. The raw Trace carries per-run-random UUIDs (cast / active
// effect / player ids) and a handful of resolve-time RNG values (Calami-Tea's
// per-round die). A raw golden would diff on every run. normaliseTrace() maps
// every UUID to a stable role token (P:caster, cast#1, fx#1, …) and redacts
// the RNG-derived keys, leaving phase order, display_kind, outcome, before/
// after deltas and every derived flag verbatim — which is exactly the surface
// S3's verbatim cutover must not move.
//
// WHY SEED THE CAST LOG DIRECTLY. Scenarios write rolls + spell_casts +
// cast_inputs straight to the tables (the seam regression-net-working-cards
// .test.ts uses), never through cast_spell_card / cast_reaction_spell_card.
// That keeps cast-time RNG (WILD's d6 branch, a contested_negate d20) out of
// the picture: the recorded value we want is simply seeded.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestCleanup,
  forceHold,
  seedActiveEffect as seedActiveEffectRaw,
  signUpSignInAndEnterRoom,
} from "../../integration/setup";

// ---------------------------------------------------------------------------
// Trace shape (mirrors src/lib/supabase/rolls.ts RawTraceStep; kept local so
// the harness has no production-code dependency it could mask a regression in)
// ---------------------------------------------------------------------------

export type TraceStep = {
  index: number;
  display_kind: string;
  source_cast: {
    cast_id: string | null;
    active_effect_id: string | null;
    card_name: string | null;
    caster_player_id: string | null;
  };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: "applied" | "no-op" | "blocked" | "backfired";
  [extra: string]: unknown;
};

export type ResolveOutcome = {
  outcome: "brewer" | "tie";
  layer: number;
  brewer_id: string | null;
  brewer_source: string | null;
  tied_player_ids: string[] | null;
  cups_made: number;
  no_modifier_gain: boolean;
  trace: TraceStep[];
};

// ---------------------------------------------------------------------------
// Phase headers of the resolver pipeline (resolve_round body, migration 0100).
// The ticket's list (0a 0b 1 2 3 4a 4b 4b-pre 4c 5) plus `3-pre`, the
// Calami-Tea per-round dice tick synthesis added in 0100 after map #350 was
// charted. Every phase must be provoked by at least one corpus scenario.
// ---------------------------------------------------------------------------

export const PHASE_TAGS = [
  "0a", // Effect Invocation — materialise Saucerer's Apprentice copies
  "0b", // Effect Invocation — seize retarget + copy / seize outcome
  "1", // Cast-Log resolution — negate / redirect / counter chains
  "2", // ward projection — polarity × domain immunity filter
  "3-pre", // Calami-Tea per_round_dice_tick synthesis
  "3", // roll-input accounting — swap / flip / reroll / advantage / fixed / pair
  "4a", // modifier-bucket effects — flat / set / mult, per player
  "4b", // persistent modifier delta projection (rest-of-day transfers)
  "4b-pre", // Bitter Leech per-round tick synthesis
  "4c", // lowest_gains_highest_modifier (Broken Biscuit)
  "5", // brewer selection — declared > override > default
] as const;

export type PhaseTag = (typeof PHASE_TAGS)[number];

export type WildBranch = 1 | 2 | 3 | 4 | 5 | 6;

// A display_kind → phase it can only have come from. Used to CHECK that a
// scenario's declared phases actually fired (declaration can't rot), not to
// derive coverage. Kinds that several phases emit (`warded`, running-sum
// modifier steps) are deliberately absent — those scenarios assert their
// phase via a structural rule in phasesWitnessedBy().
const KIND_PHASE: Partial<Record<string, PhaseTag>> = {
  contested_negate: "1",
  redirect: "1",
  dice_tick: "3",
  roll_frozen: "3",
  roll_swap: "3",
  roll_flip: "3",
  forced_reroll: "3",
  advantage: "3",
  disadvantage: "3",
  fixed_roll: "3",
  roll_pair_transform: "3",
  conditional_advantage: "3",
  flat_modifier: "4a",
  set_modifier: "4a",
  modifier_multiplier: "4a",
  lowest_gains_highest_modifier: "4c",
  targeting_skip: "5",
  declared_number_tea_maker: "5",
  tea_maker_override: "5",
};

/**
 * The set of phase headers a resolved trace proves ran. Combines the
 * kind→phase table with structural rules for the phases that emit no
 * distinctive step of their own.
 */
export function phasesWitnessedBy(trace: TraceStep[]): Set<PhaseTag> {
  // Phase 5 (brewer selection) runs on every resolve — it just emits no step
  // for a plain default pick — so it is always witnessed.
  const seen = new Set<PhaseTag>(["5"]);
  for (const step of trace) {
    const p = KIND_PHASE[step.display_kind];
    if (p) seen.add(p);

    // Phase 0a/0b — a copy / seize header step, or any step re-emitted under
    // an invocation, carries an `invocation_kind` marker.
    if (
      step.invocation_kind != null ||
      step.display_kind === "copy" ||
      step.display_kind === "seize"
    ) {
      seen.add("0a");
      seen.add("0b");
    }
    // Phase 2 — any blocked-by-ward step (from whichever phase the ward
    // pre-empted) proves the ward projection produced a hit.
    if (step.outcome === "blocked" || step.display_kind === "warded" || step.ward_card_name != null) {
      seen.add("2");
    }
    // Phase 3-pre — a `warded` step naming Calami-Tea is emitted only there.
    if (step.display_kind === "warded" && step.source_cast?.card_name === "Calami-Tea") {
      seen.add("3-pre");
    }
    // Phase 4b — a rest-of-day persistent transfer/spend step.
    if (step.rest_of_day === true) seen.add("4b");
    // Phase 4b-pre — Bitter Leech's synthesised per-round tick step.
    if (step.source_cast?.card_name === "Bitter Leech" && step.before?.type === "modifier") {
      seen.add("4b-pre");
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `rolled` is only ever emitted by Calami-Tea's per_round_dice_tick, whose die
// is rolled inside resolve_round Phase 3-pre — genuinely per-run random.
// `would_be_after` is deterministic on an ordinary ward-block step but
// RNG-derived on a Calami-Tea warded tick (greatest(1, roll + sign*rolled)),
// so it is redacted only on steps that name Calami-Tea. Redaction keeps the
// golden stable while phase / kind / outcome / ward still diff verbatim.
const ALWAYS_RNG_KEYS = new Set(["rolled"]);
const CALAMI_RNG_KEYS = new Set(["rolled", "would_be_after"]);

export type Roster = Record<string, string>; // playerId (google sub) -> label

/**
 * Rewrites a raw Trace into its stable, committable form:
 *   • every player UUID  -> `P:<label>` from the scenario roster
 *   • every cast UUID    -> `cast#N`  (N = first-seen order across the trace)
 *   • every active-effect UUID -> `fx#N`
 *   • any other UUID     -> `uuid#N`  (nothing raw ever leaks through)
 *   • RNG-derived values -> `"<rng>"`
 * Step order, indices, display_kind, outcome, before/after and all derived
 * flags are left exactly as the resolver emitted them.
 */
export function normaliseTrace(trace: TraceStep[], roster: Roster): unknown[] {
  const map = new Map<string, string>();
  for (const [id, label] of Object.entries(roster)) map.set(id, `P:${label}`);

  let castN = 0;
  let fxN = 0;
  let otherN = 0;
  const cast = (v: unknown) => assign(v, "cast");
  const fx = (v: unknown) => assign(v, "fx");

  function assign(v: unknown, kind: "cast" | "fx" | "other"): void {
    if (typeof v !== "string" || !UUID_RE.test(v) || map.has(v)) return;
    if (kind === "cast") map.set(v, `cast#${++castN}`);
    else if (kind === "fx") map.set(v, `fx#${++fxN}`);
    else map.set(v, `uuid#${++otherN}`);
  }

  // First pass — assign cast / effect tokens in deterministic first-seen order
  // so numbering never depends on object-key iteration.
  for (const step of trace) {
    cast(step.source_cast?.cast_id);
    fx(step.source_cast?.active_effect_id);
    cast(step.ward_cast_id);
    cast(step.blocked_cast_id);
    cast(step.redirected_to_cast_id);
  }

  const walk = (value: unknown, rngKeys: Set<string>, key?: string): unknown => {
    if (key && rngKeys.has(key) && (typeof value === "number" || typeof value === "string")) {
      return "<rng>";
    }
    if (typeof value === "string") {
      if (map.has(value)) return map.get(value);
      if (UUID_RE.test(value)) {
        assign(value, "other");
        return map.get(value);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, rngKeys));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, rngKeys, k);
      return out;
    }
    return value;
  };

  return trace.map((step) => {
    const rngKeys = step.source_cast?.card_name === "Calami-Tea" ? CALAMI_RNG_KEYS : ALWAYS_RNG_KEYS;
    return walk(step, rngKeys);
  }) as unknown[];
}

/** The committed golden document for one scenario. */
export function snapshotDocument(name: string, out: ResolveOutcome, roster: Roster) {
  return {
    scenario: name,
    outcome: out.outcome,
    layer: out.layer,
    brewer: out.brewer_id ? roster[out.brewer_id] ?? "<unknown>" : null,
    brewerSource: out.brewer_source,
    tiedPlayers: (out.tied_player_ids ?? []).map((id) => roster[id] ?? "<unknown>").sort(),
    cupsMade: out.cups_made,
    noModifierGain: out.no_modifier_gain,
    trace: normaliseTrace(out.trace, roster),
  };
}

// ---------------------------------------------------------------------------
// Scenario context — the seeding vocabulary handed to every scenario
// ---------------------------------------------------------------------------

export type Player = { client: SupabaseClient; googleSub: string; roomId: string };

export type SeedCastRow = {
  effectKind: string;
  effectParams: Record<string, unknown>;
  targetPlayerId: string | null;
  reactionWindowId?: string;
  castInputs?: Record<string, unknown>;
  parentCastId?: string;
  cardInstanceId?: string;
  extra?: Record<string, unknown>; // any other spell_casts column (target_role, generation, negated, source_cast_id…)
};

export type ScenarioContext = {
  admin: SupabaseClient;
  cleanup: ReturnType<typeof createTestCleanup>;
  /** Roster built as scenarios call signUp(); playerId -> label. */
  readonly roster: Roster;
  signUp: (label: string) => Promise<Player>;
  seedRoll: (
    roundId: string,
    playerId: string,
    value: number,
    modifierSnapshot?: number,
    layer?: number,
  ) => Promise<void>;
  seedCast: (
    roundId: string,
    casterId: string,
    donorCard: string,
    row: SeedCastRow,
  ) => Promise<{ castId: string; cardInstanceId: string }>;
  openWindow: (roundId: string) => Promise<string>;
  openAndCloseRound: (starter: Player, others: Player[]) => Promise<string>;
  setRoomModifier: (roomId: string, playerId: string, modifier: number) => Promise<void>;
  seedActiveEffect: (opts: Parameters<typeof seedActiveEffectRaw>[2]) => ReturnType<typeof seedActiveEffectRaw>;
  rollTransform: (
    kind: string,
    order: number,
    players: { player_id: string; before: number | null; after: number | null; warded?: boolean }[],
    extra?: Record<string, unknown>,
  ) => { roll_transform: Record<string, unknown> };
};

export type SeedResult = { roundId: string; resolveWith: SupabaseClient };

export type Scenario = {
  /** Stable slug; also the golden filename (tests/snapshots/<name>.json). */
  name: string;
  /** Phase headers this scenario is asserted to exercise. */
  phases: PhaseTag[];
  /** WILD d6 branch this scenario stands in for, if any. */
  wildBranch?: WildBranch;
  /**
   * Set when `resolve_round`'s Trace is known to differ between the first
   * resolve of a generation and a re-resolve (e.g. Phase 3-pre emits a
   * warded Calami-Tea tick step only on the generation's first pass). The
   * runner then skips its determinism re-check; the golden is the
   * first-resolve Trace. Document the reason inline.
   */
  nonIdempotent?: boolean;
  /** One-line note shown in the golden and the coverage report. */
  note: string;
  seed: (ctx: ScenarioContext) => Promise<SeedResult>;
};

/**
 * Builds a fresh ScenarioContext bound to one admin client + cleanup tracker.
 * The runner calls this per scenario and runs cleanup.run() afterwards, so no
 * two goldens can share seeded state.
 */
export function makeContext(
  admin: SupabaseClient,
  cleanup: ReturnType<typeof createTestCleanup>,
): ScenarioContext {
  const roster: Roster = {};
  const usedLabels = new Set<string>();

  const ctx: ScenarioContext = {
    admin,
    cleanup,
    roster,

    async signUp(label) {
      let slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (usedLabels.has(slug)) {
        let i = 2;
        while (usedLabels.has(`${slug}-${i}`)) i++;
        slug = `${slug}-${i}`;
      }
      usedLabels.add(slug);
      const p = await signUpSignInAndEnterRoom(admin, cleanup, slug);
      roster[p.googleSub] = slug;
      return p;
    },

    async seedRoll(roundId, playerId, value, modifierSnapshot = 0, layer = 0) {
      const { error } = await admin.from("rolls").insert({
        round_id: roundId,
        player_id: playerId,
        layer,
        value,
        input_mode: "manual",
        modifier_snapshot: modifierSnapshot,
      });
      if (error) throw error;
    },

    async seedCast(roundId, casterId, donorCard, row) {
      let instanceId = row.cardInstanceId;
      if (!instanceId) {
        instanceId = await forceHold(admin, casterId, donorCard);
        await admin
          .from("spell_deck_instances")
          .update({ location: "in_deck", held_by_player: null })
          .eq("id", instanceId);
      }
      const { data, error } = await admin
        .from("spell_casts")
        .insert({
          round_id: roundId,
          caster_id: casterId,
          card_instance_id: instanceId,
          target_player_id: row.targetPlayerId,
          target_pending: false,
          effect_kind: row.effectKind,
          effect_params: row.effectParams,
          reaction_window_id: row.reactionWindowId ?? null,
          cast_inputs: row.castInputs ?? null,
          parent_cast_id: row.parentCastId ?? null,
          ...(row.extra ?? {}),
        })
        .select("id")
        .single();
      if (error) throw error;
      return { castId: data!.id as string, cardInstanceId: instanceId! };
    },

    async openWindow(roundId) {
      const { data, error } = await admin
        .from("spell_reaction_windows")
        .insert({ round_id: roundId, layer: 0, status: "closed" })
        .select("id")
        .single();
      if (error) throw error;
      return data!.id as string;
    },

    async openAndCloseRound(starter, others) {
      const { data: roundId, error } = await starter.client.rpc("start_round");
      if (error) throw error;
      cleanup.trackRound(roundId as string);
      for (const o of others) {
        const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
        if (dErr) throw dErr;
      }
      const { error: cErr } = await starter.client.rpc("close_round", { p_round_id: roundId });
      if (cErr) throw cErr;
      return roundId as string;
    },

    async setRoomModifier(roomId, playerId, modifier) {
      const { error } = await admin
        .from("room_players")
        .update({ modifier })
        .eq("room_id", roomId)
        .eq("player_id", playerId);
      if (error) throw error;
    },

    seedActiveEffect(opts) {
      return seedActiveEffectRaw(admin, cleanup, opts);
    },

    rollTransform(kind, order, players, extra = {}) {
      return { roll_transform: { kind, order, players, ...extra } };
    },
  };

  return ctx;
}
