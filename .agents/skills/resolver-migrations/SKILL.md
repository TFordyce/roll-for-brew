---
name: resolver-migrations
description: >-
  Edit, add, or verify Postgres resolver functions in db/sql/functions/ and
  regenerate supabase/migrations/*_generated_resolver_functions.sql. Use when
  modifying stored functions such as resolve_round, cast_spell_card, or
  get_round_recap, or when npm run verify:migrations fails.
---

# Resolver SQL Migrations

Canonical source for large resolver functions lives under `db/sql/functions/`.
The corresponding numbered migration under `supabase/migrations/` and
fingerprints under `db/sql/.emitted/` are generated artifacts. Full rationale
and scope live in [db/sql/README.md](../../../db/sql/README.md).

## Steps

1. Edit `db/sql/functions/<name>.sql` (function body + `revoke`/`grant` +
   `comment on` as one unit). Leave `db/sql/.emitted/` and generated
   `supabase/migrations/*_generated_resolver_functions.sql` untouched by hand.
2. Run `npm run build:migrations` to emit the updated function into the pending
   generated migration and refresh `db/sql/.emitted/`.
3. Verify parity without writing:
   ```sh
   npm run verify:migrations
   ```
   Confirm exit code `0`. Re-run `npm run build:migrations` after rebasing if
   another migration claimed a newer number.
4. Stage and commit `db/sql/functions/**`, `db/sql/.emitted/**`, and the
   generated migration together.

## Scope check

Non-function DDL (tables, columns, constraints, triggers, RLS policies, enums)
belongs in hand-authored migrations under `supabase/migrations/`, not `db/sql/`.
