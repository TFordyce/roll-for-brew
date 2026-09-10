# Resolver functions maintained as canonical source; migrations generated

## Status

accepted — 2026-09-10. Decided by the resolver-source map wayfinder ([#350](https://github.com/TFordyce/roll-for-brew/issues/350)): a grilling + domain-modeling session on 2026-09-04 (map decisions 1–15), charted as slices S1–S4 ([#366](https://github.com/TFordyce/roll-for-brew/issues/366), [#367](https://github.com/TFordyce/roll-for-brew/issues/367), [#368](https://github.com/TFordyce/roll-for-brew/issues/368), [#369](https://github.com/TFordyce/roll-for-brew/issues/369)). Recorded via session https://claude.ai/code/session_01DYJf1XocHL4rGbGy89MLi5.

Leaves **ADR 0005** (resolver *semantics* — the deterministic resolver over the Cast Log) untouched. This decision is about *authoring*: where the stored-function source of truth lives and how it reaches the database.

## Decision

Repeatedly re-emitted resolver functions are **canonical source** under `db/sql/functions/` — one human-edited file per function. Their migrations are **generated output**: `npm run build:migrations` emits each changed function verbatim into a generated `supabase/migrations/<NNNN>_generated_resolver_functions.sql`, and `npm run verify:migrations` (a non-writing `--check`) gates every resolver PR against drift. Mechanism, workflow, numbering, and layout live in [`db/sql/README.md`](../../db/sql/README.md) — this ADR records only the choices behind it.

- **A cutover ceiling.** Migrations at and below it freeze as history; canonical source owns every function definition above it. `get_round_recap` moved as the proof (migration `0103`, [#367](https://github.com/TFordyce/roll-for-brew/issues/367)); the rest of the **Resolver pipeline** set moved verbatim in the cutover (migration `0105`, [#368](https://github.com/TFordyce/roll-for-brew/issues/368)).
- **Functions only.** Non-function DDL — tables, columns, constraints, triggers, RLS policies, enum changes — stays hand-authored. A trigger that wraps a function does not co-locate with it.
- **Scope by re-emit count.** Only functions re-emitted more than once across migrations are worth moving; single-definition helpers move the next time they change.
- **No CI.** `verify:migrations` is a documented pre-merge run and the `-- DO NOT EDIT` header is a deterrent — drift protection is advisory, not enforced. `supabase db push` on merge stays manual.

**Trade-off.** Gives up "the migration file is the source of truth" — a Supabase convention — for reviewable resolver diffs (a single-rule ordering change is a sub-150-line `db/sql/**` diff, not a 1,300–2,200-line `create or replace function` re-emit) and a local `verify` step in place of the migration being authoritative.

## Considered

- **Keep hand-authoring the re-emit migrations** (status quo). Rejected: Postgres can't patch a function body, so every one-line behaviour change lands as a full re-emit — `0096` pasted 2,108 lines of `resolve_round` for a ~135-line real delta — and the functions have no single reviewable home.
- **Co-locate canonical source under `supabase/functions/`.** Rejected: that path is CLI-reserved for Edge Functions.
- **Generate the migration but don't commit it** (build in CI or at `db push`). Rejected: `supabase start` / `db reset` read only `supabase/migrations/`, so an uncommitted generated file breaks local stack bring-up and fresh clones.
- **`verify` as `build + git diff --exit-code`** (map decision 6). Superseded by decision 15: that silently rebuilds over a hand-edit of a still-pending generated migration and passes. The non-writing `--check` fails on exactly that case.
- **Move the resolver pipeline to TypeScript.** A separate evaluation (sibling [#371](https://github.com/TFordyce/roll-for-brew/issues/371)), not this decision; it would move authority off the database and away from RLS.

## Consequences

- Review discipline shifts: the generated migration is collapsed noise and reviewers read `db/sql/**`. A resolver behaviour change with no `db/sql/**` diff is a red flag.
- Drift protection is local and advisory (a documented `verify` run plus the header), not enforced. A contributor who edits a generated migration directly and skips `verify` can still merge.
- Behaviour-preservation of the cutover rested on three checks: the permanent Trace-snapshot harness, an empty `pg_get_functiondef` diff across `db reset` before/after the verbatim cutover, and one live-data replay-equality run.
- Pre-merge migration numbering can churn: a pending generated file renumbers on rebase when another migration claims its number. Expected — `build:migrations` handles it.
