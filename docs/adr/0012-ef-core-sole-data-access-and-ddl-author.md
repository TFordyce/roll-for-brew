# EF Core is the sole data access and DDL author post-port; SQL-first for core tables until consolidation

## Status

accepted — 2026-10-08. Decided on the C# port map ([#476](https://github.com/TFordyce/roll-for-brew/issues/476)): [Decide the C# data access layer and batching](https://github.com/TFordyce/roll-for-brew/issues/491), amended by [Decide core-table schema ownership during and after the port](https://github.com/TFordyce/roll-for-brew/issues/495).

## Decision

- **One deep module, `RoomStore`.** All database access goes through three entry points: `Read(room, actor, ReadPlan)`, `Command(round, actor, decide)` and `Filler(actor, work)`. There are no ports or repository interfaces. The module hides:
  - connection and pooler settings, the transaction and the claims;
  - the round lock before the snapshot load, and the one-round-trip snapshot batch;
  - the write batch;
  - the `rooms.version` bump and `realtime.send`;
  - `RFBnn` → problem-code mapping.

  `Decision<T>(Writes, Events, Result, ReloadAfterWrite)` is the whole command contract. `Writes` is a closed set of typed cases, each with exactly one statement inside `RoomStore`. Bridges are data too: `Write.Bridge("fn", args)` and `ReadPlan` entries.
- **During the port:**
  - **Dapper** is a port-time tool, used only inside `RoomStore` for core tables.
  - **EF Core** handles the Filler tables (`orders`, `brew_ratings`, `spell_card_ratings`, `modifier_adjustments`, `admin_acting_as`) and authors their migrations. A build step scripts each migration into the next numbered `supabase/migrations` file, so there is still one runner and one deploy path.
  - **Core-table DDL** stays hand-written SQL. EF maps the core tables it touches with `ExcludeFromMigrations()`, so each table has exactly one author.
- **EF consolidation slice (after slice 8):**
  - Dapper is swapped out inside `RoomStore`. The exit check is that the package is gone and the per-command round-trip count is unchanged.
  - EF scaffolds the live schema behind an empty baseline migration marked as applied, and from then on authors every DDL change, core and Filler, still scripted into `supabase/migrations`.
  - Supabase-specific DDL (RLS, grants, realtime publication, `auth.users` FKs) and the surviving identity functions go in as `migrationBuilder.Sql`.
- **Drift is enforced in CI behind `ci-ok`:**
  - core row types are checked by the Testcontainers layer running against the real migrations;
  - Filler tables are checked by `has-pending-model-changes` plus a scripted-SQL comparison;
  - after consolidation, a `supabase/migrations` file without the `-- ef-scripted` header is rejected.

## Considered

- **EF Core for everything from slice 0.** Rejected: plpgsql still reads the core tables, so EF would become a second DDL author beside hand-written SQL. The rules core is also bridge-heavy and writes from a pure write list with no change tracking.
- **Dapper permanently.** Rejected: EF Core is the owner's long-term data access style. Keeping Dapper would leave two SQL access tools.
- **Loader and persister ports with in-memory fakes.** Rejected: Postgres runs locally through Testcontainers, so a port would be a hypothetical seam with only one adapter.
- **A separate migration runner for EF** (`database update` at deploy). Rejected: it would be a second path to the schema next to the Supabase GitHub integration.

## Consequences

- Moving core tables to EF later changes `RoomStore`'s implementation, not its interface or its tests.
- For tables that still-SQL functions reference (`brew_ratings`, `modifier_adjustments`, `admin_acting_as`), EF migrations must stay additive-only until those functions are gone.
- Transaction pooler settings: `Max Auto Prepare=0`, `No Reset On Close=true`, `Multiplexing=false`, `Max Pool Size=5`. Every database touch runs inside an explicit transaction.
