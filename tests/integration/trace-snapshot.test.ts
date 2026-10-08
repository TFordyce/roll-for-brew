// Trace-snapshot harness — the golden runner (issue #366, map #350 slice S1).
//
// For every corpus scenario: seed a fresh round, call resolve_round(uuid)
// once, normalise the Resolution Trace (UUIDs -> role tokens, resolve-time
// RNG redacted) and diff it against tests/snapshots/<name>.json. `vitest -u`
// rewrites the goldens as a reviewable per-scenario diff.
//
// This is permanent infrastructure, not scaffolding: it is the mechanical
// behaviour-preservation proof S3 (the verbatim db/sql cutover) leans on, and
// the standing sub-round regression net for every resolver change after it.
// Lives under tests/integration/ so `npm run test:integration:local` and any
// `vitest run tests/integration` pick it up automatically.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestAdminClient, createTestCleanup, hasAnonTestEnv } from "./setup";
import { mkdirSync, writeFileSync } from "node:fs";
import { CORPUS } from "../snapshots/corpus";
import { captureInputFixture } from "../snapshots/corpus/inputFixture";
import {
  composedFoldViolations,
  makeContext,
  normaliseScrappedGenerations,
  normaliseSummary,
  phasesWitnessedBy,
  snapshotDocument,
  normaliseTrace,
  type ResolveOutcome,
  type SummaryEntry,
  type TraceStep,
} from "../snapshots/corpus/framework";

/** The slice of get_round_recap's payload the runner checks. */
type RecapPayload = { provisional: boolean; trace: TraceStep[]; players: SummaryEntry[] | null };

/**
 * Everything a resolve can write for one round: the round row itself, its Cast
 * Log (including rows the resolver synthesises and the flags it caches), and
 * the room's modifier cache. Compared before/after `_rr_resolve` to prove the
 * dry run leaves no writes.
 */
async function readRoundState(admin: SupabaseClient, roundId: string) {
  const { data: round, error: rErr } = await admin.from("rounds").select("*").eq("id", roundId).single();
  if (rErr) throw rErr;
  const { data: casts, error: cErr } = await admin
    .from("spell_casts")
    .select("*")
    .eq("round_id", roundId)
    .order("id");
  if (cErr) throw cErr;
  const { data: roomPlayers, error: pErr } = await admin
    .from("room_players")
    .select("player_id, modifier")
    .eq("room_id", round!.room_id)
    .order("player_id");
  if (pErr) throw pErr;
  return { round, casts, roomPlayers };
}

// Phase headers that emit no distinctive Trace step of their own, so a
// scenario declaring them cannot be cross-checked against its live trace.
const STRUCTURALLY_INVISIBLE = new Set(["0a", "4a"]);

describe.skipIf(!hasAnonTestEnv)("issue #366 — resolve_round Trace-snapshot corpus", () => {
  let admin: SupabaseClient;

  beforeAll(() => {
    admin = createTestAdminClient();
  });

  // Each scenario gets its own cleanup layer so no two goldens share seeded
  // state (ticket: "Seeded fresh per scenario").
  let cleanup: ReturnType<typeof createTestCleanup>;
  afterEach(() => cleanup.run());

  it.each(CORPUS.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    cleanup = createTestCleanup(admin);
    const ctx = makeContext(admin, cleanup);

    const { roundId, resolveWith } = await scenario.seed(ctx);

    // Issue #537: EMIT_INPUT_FIXTURES=1 writes the state this scenario resolves from (the C# RoundSnapshot
    // wire shape) to tests/snapshots/inputs/. Captured before any resolver write cache exists. Goldens are
    // untouched; normal runs do not emit.
    if (process.env.EMIT_INPUT_FIXTURES) {
      const fixture = await captureInputFixture(admin, scenario.name, roundId, ctx.roster);
      mkdirSync("tests/snapshots/inputs", { recursive: true });
      writeFileSync(`tests/snapshots/inputs/${scenario.name}.input.json`, JSON.stringify(fixture, null, 2) + "\n");
    }

    // Issue #409 (ADR 0007): the Provisional Recap. With layer 0 complete and
    // the round still live, get_round_recap dry-runs the resolver — and a
    // page render must leave the round exactly as it found it.
    const beforeRecap = await readRoundState(admin, roundId);
    const { data: provData, error: provError } = await resolveWith.rpc("get_round_recap", { p_round_id: roundId });
    expect(provError, `get_round_recap errored: ${provError?.message}`).toBeNull();
    expect(await readRoundState(admin, roundId), "get_round_recap wrote round state").toEqual(beforeRecap);
    const provisional = provData as RecapPayload;
    expect(provisional.provisional).toBe(true);

    const { data, error } = await resolveWith.rpc("resolve_round", { p_round_id: roundId });
    expect(error, `resolve_round errored: ${error?.message}`).toBeNull();
    const out = data as ResolveOutcome;

    const afterResolve = await readRoundState(admin, roundId);
    // Issue #407: the summary is persisted beside the Trace.
    expect(afterResolve.round.resolution_summary).toEqual(out.players);
    // Issue #404: the dry run leaves a resolved round's stored Trace, summary
    // and caches untouched too.
    const { error: dryAgainError } = await admin.rpc("_rr_resolve", { p_round_id: roundId });
    expect(dryAgainError).toBeNull();
    expect(await readRoundState(admin, roundId), "_rr_resolve wrote over a resolved round").toEqual(
      afterResolve,
    );

    // The final Recap is the stored resolution, no longer provisional.
    const { data: finalData } = await resolveWith.rpc("get_round_recap", { p_round_id: roundId });
    const final = finalData as RecapPayload;
    expect(final.provisional).toBe(false);
    expect(final.trace).toEqual(out.trace);
    expect(final.players).toEqual(out.players);

    // Runner invariant (ADR 0007): with no reactions pending, the Provisional
    // Recap IS the resolution — same normalised Trace, same summary.
    if (!scenario.dryRunDiffers) {
      expect(
        {
          trace: normaliseTrace(provisional.trace, ctx.roster),
          players: normaliseSummary(provisional.players, ctx.roster),
        },
        "Provisional Recap disagrees with the final one",
      ).toEqual({
        trace: normaliseTrace(final.trace, ctx.roster),
        players: normaliseSummary(final.players, ctx.roster),
      });
    }

    // The golden must be reproducible: a second resolve over identical inputs
    // must yield the same *normalised* Trace (raw UUIDs of any rows the first
    // resolve synthesised differ, which normalisation absorbs). Scenarios the
    // resolver is knowingly non-idempotent for opt out via `nonIdempotent`.
    if (!scenario.nonIdempotent) {
      const { data: again } = await resolveWith.rpc("resolve_round", { p_round_id: roundId });
      const a = normaliseTrace((data as ResolveOutcome).trace, ctx.roster);
      const b = normaliseTrace((again as ResolveOutcome).trace, ctx.roster);
      expect(
        JSON.stringify(b, null, 2),
        "re-resolving this scenario produced a different normalised Trace",
      ).toBe(JSON.stringify(a, null, 2));
    }

    // The declared phases must actually fire (declarations can't silently rot).
    const witnessed = phasesWitnessedBy(out.trace);
    const declaredButUnseen = scenario.phases.filter(
      (p) => !STRUCTURALLY_INVISIBLE.has(p) && !witnessed.has(p),
    );
    expect(
      declaredButUnseen,
      `${scenario.name} declares phases its trace does not witness: ${declaredButUnseen.join(", ")}`,
    ).toEqual([]);

    // Issue #407: the summary's composed modifier is exactly the snapshot
    // folded through the Trace's modifier steps — so a row's terms always add
    // up to its total.
    expect(composedFoldViolations(out), "composed modifier moved without a Trace step").toEqual([]);

    const doc: Record<string, unknown> = snapshotDocument(scenario.name, out, ctx.roster);
    // Issue #408: a replayed round also pins each scrapped generation's own
    // summary (absent for every never-replayed scenario).
    const scrapped = afterResolve.round.scrapped_generations as Parameters<typeof normaliseScrappedGenerations>[0];
    if (scrapped?.length) doc.scrappedGenerations = normaliseScrappedGenerations(scrapped, ctx.roster);
    await expect(JSON.stringify(doc, null, 2) + "\n").toMatchFileSnapshot(
      `../snapshots/${scenario.name}.json`,
    );
  });
});
