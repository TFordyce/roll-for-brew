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
import { CORPUS } from "../snapshots/corpus";
import {
  makeContext,
  phasesWitnessedBy,
  snapshotDocument,
  normaliseTrace,
  type ResolveOutcome,
} from "../snapshots/corpus/framework";

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

    const { data, error } = await resolveWith.rpc("resolve_round", { p_round_id: roundId });
    expect(error, `resolve_round errored: ${error?.message}`).toBeNull();
    const out = data as ResolveOutcome;

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

    const doc = snapshotDocument(scenario.name, out, ctx.roster);
    await expect(JSON.stringify(doc, null, 2) + "\n").toMatchFileSnapshot(
      `../snapshots/${scenario.name}.json`,
    );
  });
});
