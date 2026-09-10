# Resolver functions maintained as canonical source; migrations generated

## Status

accepted — 2026-09-10. Decided by the resolver-source map wayfinder ([#350](https://github.com/TFordyce/roll-for-brew/issues/350)): a grilling + domain-modeling session on 2026-09-04 (map decisions 1–15), charted as slices S1–S4 ([#366](https://github.com/TFordyce/roll-for-brew/issues/366), [#367](https://github.com/TFordyce/roll-for-brew/issues/367), [#368](https://github.com/TFordyce/roll-for-brew/issues/368), [#369](https://github.com/TFordyce/roll-for-brew/issues/369)). Recorded via session https://claude.ai/code/session_01DYJf1XocHL4rGbGy89MLi5.

Leaves **ADR 0005** (resolver *semantics* — the deterministic resolver over the Cast Log) untouched. This decision is about *authoring*: where the stored-function source of truth lives and how it reaches the database.

## Decision

Repeatedly re-emitted resolver functions are maintained as **canonical, reviewable source** under `db/sql/functions/`, and their migrations are **generated output**.

- **Canonical source.** One file per function at `db/sql/functions/<name>.sql`, carrying the function body + its `revoke`/`grant`s + its `comment on` as a single unit. Humans edit these.
- **Generated migrations.** `npm run build:migrations` (`scripts/build-migrations.mjs`, no new dependency) diffs each canonical file against its committed byte fingerprint `db/sql/.emitted/<name>.sql` and writes each changed function **verbatim** — LF, wrapped in `-- BEGIN/END db/sql/functions/<name>.sql` markers — into the next *pending* generated migration `supabase/migrations/<NNNN>_generated_resolver_functions.sql`, creating it if there isn't one, then updates `.emitted/`.
- **Pending vs frozen** is decided purely by whether that generated file is already on `origin/master` (fallback `master`) — no state file. A pending file keeps being rewritten by each build and **renumbers** above the ceiling on rebase if another migration takes its number; once it merges it freezes like any other migration and the next function change starts a fresh one.
- **The generated migration is committed** (so `supabase start` / `supabase db reset` work from `supabase/migrations/` alone), carries a `-- GENERATED FROM db/sql/… — DO NOT EDIT` header, and is marked `linguist-generated` + `-diff` so GitHub collapses it. Review reads the `db/sql/**` diff, not the generated migration.
- **The cutover boundary.** Migrations at and below the cutover ceiling freeze as history; canonical source owns every function definition above it. `get_round_recap` moved first as the proof ([#367](https://github.com/TFordyce/roll-for-brew/issues/367), migration `0103`); the verbatim cutover of the rest of the **Resolver pipeline** set followed ([#368](https://github.com/TFordyce/roll-for-brew/issues/368), migration `0105`).
- **Non-function DDL stays hand-authored.** Tables, columns, constraints, triggers, RLS policies, and enum changes remain hand-authored migrations in `supabase/migrations/`. `db/sql/` is functions only; a trigger that wraps a function still gets its own hand-authored migration and does not co-locate with the function file.
- **Scope.** Only functions re-emitted more than once across migrations are worth moving; single-definition helpers move the next time they actually change.
- **Drift guard, no CI.** `npm run verify:migrations` (= `build-migrations.mjs --check` — recompute *without writing*) is run before every resolver PR merges and exits non-zero with a named reason if the committed generated migration or any `.emitted/` fingerprint is stale (a hand-edited generated file, or a skipped build). The `DO NOT EDIT` header is the human deterrent. `supabase db push` on merge stays manual.

**Trade-off.** This gives up "the migration file is the source of truth" — a Supabase convention — in exchange for reviewable resolver diffs (a single-rule ordering change is a sub-150-line `db/sql/**` diff instead of a 1,300–2,200-line `create or replace function` re-emit) and a local `verify` step in place of the migration file being authoritative.

## Considered

- **Keep hand-authoring the re-emit migrations** (status quo). Rejected: Postgres can't patch a function body, so every one-line behaviour change lands as a full re-emit — `0096` pasted 2,108 lines of `resolve_round` for a ~135-line real delta — and the functions have no single reviewable home.
- **Co-locate canonical source under `supabase/functions/`.** Rejected: that path is CLI-reserved for Edge Functions.
- **Generate the migration but don't commit it** (build in CI or at `db push`). Rejected: `supabase start` / `db reset` read only `supabase/migrations/`, so an uncommitted generated file breaks local stack bring-up and fresh clones.
- **`verify` as `build + git diff --exit-code`** (map decision 6). Superseded by decision 15: that silently rebuilds over a hand-edit of a still-pending generated migration and passes. The non-writing `--check` fails on exactly that case.
- **Move the resolver pipeline to TypeScript.** A separate evaluation (sibling [#371](https://github.com/TFordyce/roll-for-brew/issues/371)), not this decision; it would move authority off the database and away from RLS.

## Consequences

- Resolver PRs gain a fixed extra step: edit `db/sql/functions/**`, `npm run build:migrations`, `npm run verify:migrations`, then commit the `functions/**` + `.emitted/**` + generated migration together.
- Review discipline shifts: the generated migration is collapsed noise and reviewers read `db/sql/**`. A resolver behaviour change with no `db/sql/**` diff is a red flag.
- Drift protection is local and advisory (a documented `verify` run plus the header), not enforced. A contributor who edits a generated migration directly and skips `verify` can still merge.
- Behaviour-preservation of the cutover itself rests on the three legs in map decision 7: the permanent Trace-snapshot harness (S1), an empty `pg_get_functiondef` diff across `db reset` before/after the verbatim cutover (S3), and one live-data replay-equality run (S3).
- Pre-merge migration numbering can churn: a pending generated file renumbers on rebase when another migration claims its number. Expected — `build:migrations` handles it.
