# The per-player roll row renders the resolver's own output, live and resolved

## Status

accepted — 2026-09-29. Decided in an `/improve-codebase-architecture` review (candidate #1, "render the per-player roll row from the Resolution Trace") followed by a grilling session. Extends **ADR 0005**'s "no second explanation path" commitment from the Round Recap to the per-player roll row, and into the live reaction window. Leaves ADR 0005's semantics and ADR 0006's authoring model untouched.

## Context

`RoundReveal`'s per-player "roll + modifier = total" badge was recomposed in TypeScript (`modifierBucket`, `rollCalculationEffects`, and `rerollChain` re-running `resolveLayer`). It started from the live roster modifier, and its input was a preview RPC (`get_round_modifier_effects`) that knows nothing about wards, redirects, backfire, persistent transfers or lowest-gains-highest. So the badge could contradict the Round Recap rendered directly above it. The TS path existed partly because the row renders before any Resolution Trace exists: layer-0 rolls are revealed when the reaction window opens, and `resolve_round` only runs at finalize.

## Decision

- **Resolution Summary.** `resolve_round` persists per-player layer-0 final values (roll, roll-time modifier, composed modifier, total, nat standing, Calami-Tea floor) in a sibling column beside `rounds.resolution_trace`. The Trace array is unchanged. The row's badge reads the summary. Its expression terms are the Trace steps targeting that player.
- **Provisional Recap: a pure resolver runs on read.** The body of `resolve_round(uuid)` moves into a non-persisting `_rr_resolve(uuid)`. While layer 0 is complete but the round is still live, `get_round_recap` dry-runs it and returns the Trace and summary marked provisional. Any room viewer can therefore trigger a full resolver evaluation, once per cast/window/pending-die event. That is deliberate: it is the only way the live view uses the same implementation as the final one. The UI labels it "so far" and never shows a brewer or tie from it.
- **Tie layers keep a TS nat-1/nat-20 rule.** Layers > 0 have no spell logic and store no per-player data. Their rows render `roll + snapshot`, and `classifyRollCalculation` stays for those rows only, pinned to `_rr_pick_lowest`'s 3-argument form. Tie membership is read from the next layer's participant set, not recomputed.
- **Rounds resolved before this change render degraded.** They show the roll and roll-time modifier plus any Trace terms, with no total. There is no backfill.

## Considered

- **Keep a TS preview for the live window only, switching to the Trace at resolution.** Rejected: it keeps a second explanation path alive exactly when players are deciding whether to react.
- **A `p_persist` flag on `resolve_round` called by viewers.** Rejected: it exposes a writer to every viewer behind a flag and adds a second client fetch. The pure-function split keeps the viewer-callable function write-free.
- **Fold per-player totals from Trace steps in TS instead of persisting a summary.** Rejected: it depends on an unguarded rule that every composed-modifier change emits a step, and it still restates the nat and Calami-Tea rules in TS.
- **Reshape `resolution_trace` into `{steps, players}`.** Rejected: it breaks the Trace contract ADR 0005 calls out, plus scrapped-generation snapshots and every stored historic trace.
- **Persist a per-layer summary at every tie layer.** Rejected for now: it adds writes to the tie branch that ADR 0005 keeps pure, to replace a one-line, spell-free rule. Revisit if tie layers ever gain spell logic.
- **Backfill historic summaries by re-running the resolver.** Rejected: resolver rules have changed since (e.g. #289), so a re-run could disagree with the round's own stored Trace.

## Consequences

- The Trace-snapshot harness guards the summary as well as the Trace. Goldens include each player's summary, and the runner asserts two invariants: the summary equals the snapshot folded with the Trace's `modifier` steps, and the provisional run equals the final run when no reactions are pending.
- `_rr_resolve` must stay free of writes. A write added there would run on every viewer's page render.
