# `db/sql/` — canonical resolver-function source

Postgres can't patch a function body. Every change to a stored function is a
full `create or replace function` re-emit, so hand-writing those as migrations
meant a one-line behaviour change landed as a 2,000-line migration diff and the
functions had no single reviewable home. See issue
[#350](https://github.com/TFordyce/roll-for-brew/issues/350).

Here the **function is canonical source** and the **migration is generated
output**.

```
db/sql/
  functions/<name>.sql   canonical: body + revoke/grant + `comment on`, one unit.
                         Humans edit these.
  .emitted/<name>.sql    a byte copy of what last went into a migration.
                         Committed. The build's change detector diffs canonical
                         against this. Do not edit by hand.
```

`supabase/migrations/` still holds every migration and is still the only thing
`supabase start` / `supabase db reset` read. The generated ones are named
`<NNNN>_generated_resolver_functions.sql`, carry a
`-- GENERATED FROM db/sql/… — DO NOT EDIT` header, and are marked
`linguist-generated` so GitHub collapses them in review. **Review the
`db/sql/**` diff, not the generated migration.**

## Changing a resolver function

1. Edit `db/sql/functions/<name>.sql`.
2. `npm run build:migrations`.
   - Writes the changed function(s) into the next pending generated migration,
     creating it if there isn't one, and updates `.emitted/`.
3. `npm run verify:migrations` — recomputes the generated migration from
   `db/sql/functions/` **without writing** and exits non-zero if the committed
   generated migration or any `.emitted/` fingerprint is out of sync (a
   hand-edited generated file, or a skipped build). Must pass before merge.
4. Commit the `db/sql/functions/**`, `db/sql/.emitted/**` and
   `supabase/migrations/<NNNN>_generated_resolver_functions.sql` changes
   together.
5. On merge, run `supabase db push` against the hosted project (manual — no CI).

## Numbering

The build claims `(highest existing migration number) + 1` **at build time**.
While the generated migration is unmerged (not yet on `origin/master`), each
`build:migrations` run keeps rewriting *that same file*; if another migration
has taken its number in the meantime, re-running after a rebase **renumbers**
it above the new ceiling. Once it merges it freezes like any other migration
and the next function change starts a fresh one.

## What does *not* live here

`db/sql/` is **functions only**. Non-function DDL — tables, columns,
constraints, triggers, RLS policies, enum changes — stays as hand-authored
migrations in `supabase/migrations/`. A trigger that wraps a function still
gets its own hand-authored migration; it does not co-locate with the function
file.

## Scope

Only functions that are re-emitted more than once across migrations are worth
moving here. The pipeline landed in
[#367](https://github.com/TFordyce/roll-for-brew/issues/367) moving only
`get_round_recap` (migration `0103`) as the proof; the verbatim cutover of the
rest —
[#368](https://github.com/TFordyce/roll-for-brew/issues/368), migration
`0105` — moved the **resolver pipeline** set:

- the pipeline entrypoints and their orchestrators: `resolve_round`,
  `cast_spell_card`, `cast_reaction_spell_card`, `start_round`, `close_round`,
  `submit_roll`, `submit_roll_as`;
- the multi-definition `_rr_*` helpers: `_rr_trace_step`,
  `_rr_cast_log_resolution`, `_rr_active_ward_gate`, `_rr_scrap_round`,
  `_rr_pick_lowest`, `_rr_apply_fixed_roll`.

Deliberately **not** moved in the cutover, though they are re-emitted more than
once: the resolver's roll/effect shims and readers
(`get_round_modifier_effects`, `apply_roll_swap`, `apply_roll_flip`,
`apply_forced_reroll`, `set_spell_cast_target`,
`record_active_effect_if_persistent`, `rebuild_active_effects_projection`,
`get_current_layer_rolls_if_complete`,
`get_completed_layer_rolls_for_stall_resolution`, …). They are not part of the
phase orchestration that #350 exists to make reviewable, and a single-rule
resolution change does not touch them. Each moves here the next time it
actually changes (the same rule single-definition helpers follow).
