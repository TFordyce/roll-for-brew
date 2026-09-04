// Trace-snapshot harness — coverage checklist (issue #366, map #350 slice S1).
//
// A pure guard (no DB) that fails the moment the corpus stops covering a
// resolver-pipeline phase header or a WILD d6 branch. When resolve_round
// grows a phase, add its tag to PHASE_TAGS (framework.ts) and this test goes
// red until a corpus scenario provokes it.

import { describe, expect, it } from "vitest";
import { CORPUS } from "../snapshots/corpus";
import { PHASE_TAGS, type WildBranch } from "../snapshots/corpus/framework";

describe("issue #366 — Trace-snapshot corpus coverage", () => {
  it("every resolver-pipeline phase header is provoked by at least one scenario", () => {
    const covered = new Set(CORPUS.flatMap((s) => s.phases));
    const missing = PHASE_TAGS.filter((p) => !covered.has(p));
    expect(missing, `phase headers with no corpus scenario: ${missing.join(", ")}`).toEqual([]);
  });

  it("every WILD d6 branch (1..6) is represented", () => {
    const covered = new Set(
      CORPUS.map((s) => s.wildBranch).filter((b): b is WildBranch => b != null),
    );
    const missing = ([1, 2, 3, 4, 5, 6] as const).filter((b) => !covered.has(b));
    expect(missing, `WILD branches with no corpus scenario: ${missing.join(", ")}`).toEqual([]);
  });

  it("scenario names are unique (each is a golden filename)", () => {
    const names = CORPUS.map((s) => s.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `duplicate scenario names: ${[...new Set(dupes)].join(", ")}`).toEqual([]);
    for (const n of names) {
      expect(n, `scenario name is not filename-safe: ${n}`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it("declares a non-trivial corpus (ticket: ~30-40 seeded rounds)", () => {
    // A floor, not the target — the runner is where scenarios earn their keep.
    expect(CORPUS.length).toBeGreaterThanOrEqual(24);
  });
});
