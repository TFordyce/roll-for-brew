# Port spec: rules engine from plpgsql to a C# API

The buildable spec charted by the wayfinder map [Port rules engine to C# API](https://github.com/TFordyce/roll-for-brew/issues/476). Tracked as [Spec: port the rules engine to a C# API](https://github.com/TFordyce/roll-for-brew/issues/502), whose sub-issues are the slice tickets.

**How to read this.** Each decision lives in one place: its decision ticket on the map, or an ADR. This spec gists each decision and links to it, and never restates it. When a slice ticket and this spec disagree, the linked decision wins, then this spec, then the slice ticket. Only these things live here and nowhere else: the project layout, the slice lifecycle and catalogue, the checks still owed, the retained-SQL list, and the [error-code table](error-codes.md).

**Why.**
- Dev is slow: integration tests run serially against one real Supabase stack.
- Production is slow on free tiers: every live update re-renders the room page with about 44 serial reads.
- The owner is a .NET developer.

**Shape.**
- Next.js UI (stays on Vercel `dub1`).
- ASP.NET Core API (Cloud Run europe-west1) with a pure C# domain library.
- Supabase stays as Postgres, Auth and Realtime.
- Migrated by a top-down strangler. Whole project costs £0–5/month.

## ADRs

| ADR | Decision |
|---|---|
| [0009](../adr/0009-rules-engine-ported-to-csharp-by-top-down-strangler.md) | Top-down strangler by entry point; C# may call SQL, never the reverse; `port_flags`; shadow evaluator; zero rules logic in Postgres at the end. Supersedes 0006 after slice 8. |
| [0010](../adr/0010-round-resolution-is-pure-evaluate-then-commit.md) | `RoundSnapshot` → pure `Evaluate` → pure `Commit` write list; Trace jsonb frozen; lazy `StallCheck`. Supersedes 0008 at slice 2b. |
| [0011](../adr/0011-broadcasts-are-in-transaction-versioned-hints.md) | `realtime.send` inside the write transaction; `room-changed { version }`; clients refetch one room view. |
| [0012](../adr/0012-ef-core-sole-data-access-and-ddl-author.md) | One deep `RoomStore` module; Dapper transitional; EF Core sole data access and DDL author after the consolidation slice. |
| [0013](../adr/0013-api-database-identity-and-authorization.md) | `rfb_api` BYPASSRLS role, claims GUC per transaction, .NET sole authorizer, RLS deny-by-default, PostgREST closed. |

ADRs 0001, 0002, 0003, 0004, 0005 and 0007 stand.

## Decisions index

| Concern | Gist | Decided in |
|---|---|---|
| Hosting | Cloud Run europe-west1, scale to zero, ReadyToRun (no AOT, no keep-warm until measured), browser calls the API directly, transaction pooler 6543, max-instances 2, £1 budget alert | [Decide hosting for the C# API](https://github.com/TFordyce/roll-for-brew/issues/478) ([research](https://github.com/TFordyce/roll-for-brew/issues/477)) |
| SQL work during the port | Rules freeze; SQL bug fixes only, each with a parity snapshot; per-slice port freeze window; weekday play continues, so flips happen outside play hours | [Decide how much new SQL feature work is allowed during the port](https://github.com/TFordyce/roll-for-brew/issues/479) |
| Tests | Pure domain / Testcontainers (template DB per test class) / thin API; `tests/snapshots` goldens are the single oracle; TS corpus emits input fixtures; TS integration suite retired by behaviour | [Decide test strategy](https://github.com/TFordyce/roll-for-brew/issues/480) |
| Auth and Acting As | API validates the Supabase JWT (JWKS); claims set per transaction; Acting As resolved server-side through `current_player_id`; ADR 0001 unamended | [Decide Supabase JWT auth and Acting As in the API](https://github.com/TFordyce/roll-for-brew/issues/481), amended by ADR 0013 |
| State loading | One Room-keyed `RoundSnapshot` in one batched round trip after the round-row `for update`; effect liveness is a pure C# port of `_rr_active_effects_as_of`; caches output-only | [Decide how the API loads state](https://github.com/TFordyce/roll-for-brew/issues/482) |
| Evaluate / Commit | `Evaluate(RoundSnapshot, IDieRoller) -> Resolution` as a phase pipeline; preview = Evaluate without persister; `Commit(Resolution) -> Writes`; one `AdvanceRound` | [Decide how to split pure evaluation from writes](https://github.com/TFordyce/roll-for-brew/issues/483) |
| Seam and slice order | Top-down entry-point slices, bridges, `port_flags`, lifecycle exits 1–4 | [Decide the strangler seam and slice order](https://github.com/TFordyce/roll-for-brew/issues/484) |
| API contract | Minimal APIs, resource routes else command sub-routes; C# is DTO source → OpenAPI → committed `openapi-typescript`; problem+json named codes; no versioning; wrappers keep signatures, switch per flag | [Decide the API contract and TypeScript client](https://github.com/TFordyce/roll-for-brew/issues/485) |
| Realtime | In-transaction `realtime.send`; `room-changed` + 3 animation events; resync on reconnect / tab visible | [Decide realtime broadcasts after commit](https://github.com/TFordyce/roll-for-brew/issues/486) |
| Stall and timers | Lazy `StallCheck(snapshot, dbNow)` on every load; `nextStallDeadline` in the view; interim `enforceStall` server action until slice 7 | [Decide who runs stall enforcement and timers](https://github.com/TFordyce/roll-for-brew/issues/490) |
| Data access | `RoomStore` (`Read` / `Command` / `Filler`); `Decision<T>`; bridges as data; claims ride the first batch; pooler settings | [Decide the C# data access layer and batching](https://github.com/TFordyce/roll-for-brew/issues/491), amended by [#495](https://github.com/TFordyce/roll-for-brew/issues/495) and [#496](https://github.com/TFordyce/roll-for-brew/issues/496) |
| Postgres end state | Zero rules logic; identity plumbing, shape constraints and `stats_*` views stay; `db/sql` shrinks per slice | [Decide the end state of rules logic in Postgres](https://github.com/TFordyce/roll-for-brew/issues/492) |
| CI and deploy | Monorepo `api/`; one `ci.yml` behind `ci-ok`; Cloud Build trigger on master; startup schema gate; Secret Manager; no staging | [Decide the CI and deploy pipeline](https://github.com/TFordyce/roll-for-brew/issues/493) |
| Room view | `{ version, room, viewer }` screen model; `useSyncExternalStore` store; request-sequence + version ordering; no optimistic UI; mapping of today's reads | [Decide the room-view DTO and client room store](https://github.com/TFordyce/roll-for-brew/issues/494) |
| Schema ownership | Core DDL hand-written SQL during the port; Filler tables EF-authored; EF consolidation slice after slice 8; drift enforced in CI | [Decide core-table schema ownership](https://github.com/TFordyce/roll-for-brew/issues/495) |
| DB identity and RLS | `rfb_api` role; per-slice revocation; RLS on with no policies; Data API off after a check | [Decide the end state of RLS and rpc grants](https://github.com/TFordyce/roll-for-brew/issues/496) ([research](https://github.com/TFordyce/roll-for-brew/issues/501)) |

## Inputs

- [`sql-call-graph.md`](sql-call-graph.md): every function's level, callees, writes and caller count. A slice's bridge and deletion lists are computed from it at slice entry.
- [`error-codes.md`](error-codes.md): `RFBnn` → problem `code` and HTTP status.
- `tests/snapshots/*.json` (goldens) and `tests/snapshots/corpus` (scenario authoring).
- Research write-ups, kept on unmerged branches by design:
  - [hosting free tier](https://github.com/TFordyce/roll-for-brew/blob/research/hosting-free-tier/docs/port/research/hosting-free-tier.md)
  - [Supabase API role](https://github.com/TFordyce/roll-for-brew/blob/research/supabase-api-role/docs/port/research/supabase-api-role.md)

## Project layout

```
api/
  RollForBrew.sln
  src/Domain/   pure C#, BCL only: RoundSnapshot, Evaluate, Commit, StallCheck, room-view projections, helper modules
  src/Api/      Minimal API endpoints, auth, ProblemDetails, RoomStore (Dapper + EF, internal), EF Filler model + Migrations/
  tests/Domain.Tests/   pure tests + goldens as xUnit theories over tests/snapshots
  tests/Api.Tests/      Testcontainers (RoomStore against real migrations) + thin API layer (WebApplicationFactory)
  Dockerfile    ReadyToRun
  cloudbuild.yaml
src/lib/api/    generated openapi-typescript client (committed) + thin fetch wrapper
src/lib/supabase/*.ts   wrappers keep their signatures; switch per port flag between .rpc and src/lib/api
```

`RoomStore` sits in `Api` as an internal module. Nothing outside it references Dapper, Npgsql or `RfbDbContext`. `Domain` references nothing outside the BCL.

## Words used in this spec

- **Entry point:** a SQL function no other SQL function calls ("called by 0" in the call graph). Slices port entry points.
- **Bridge:** a SQL function called from C# inside the API transaction. A read bridge is a `ReadPlan` entry; a write bridge is a `Write.Bridge("fn", args)`. Every bridge is listed on its slice ticket and removed by a later one.
- **Port flag:** a `port_flags` row `(slice_key, room_id null)`. A null `room_id` means global. The TS wrapper reads it per request: API if a row matches, `.rpc` otherwise.
- **Play-day:** a weekday on which at least one round resolves in a production room.
- **Soak:** consecutive play-days with the flag global and no rollback.
- **Filler:** a CRUD slice over a table family with no rules logic, built on EF Core, running in parallel with the core slices once slice 0 is done.

## Slice lifecycle

Every slice ticket follows this template. Where a slice is split into several tickets, exits 2–4 sit on the slice's **last** ticket.

- **Entry.**
  - Core slices: the previous core slice has reached exit 4. Exception: 2a's three pure-domain tickets (helpers, tea-maker selection, `Evaluate`) need only slice 1's snapshot loader, because they touch no production path. 2a's shadow ticket waits for all of slice 1.
  - The port freeze window opens on the slice's functions: SQL bug fixes only, each mirrored into C# in the same PR or as a checklist item on the ticket.
  - Confirm the ticket's starting **bridge list** and **SQL-deletion list** against the call graph (regenerate it if functions have changed), and edit the ticket.
- **Exit 1, built.** Goldens pass unchanged. Behaviour is covered at the domain, Testcontainers and API layers, and every TS integration test for the slice's RPCs is ported or has an equivalent. The bridge list is current. The OpenAPI client is regenerated and committed.
- **Exit 2.** The flag is on in the test room. The owner plays it there.
- **Exit 3.** The flag is global, followed by a 5-play-day soak with no rollback (2a uses its own gate instead: 10 consecutive play-days with zero shadow diffs).
- **Exit 4.** In one PR:
  - delete the SQL entry points and now-dead helpers from `db/sql/functions/`, emitting `drop function` in the generated migration;
  - revoke `execute` on them;
  - revoke grants and policies on any table whose last PostgREST reader or writer this slice removed (ADR 0013);
  - delete the flag row and the TS `.rpc` branch;
  - retire or move the slice's TS integration tests.
- **Flag flips** happen outside weekday play hours.
- **Rollback.** Until exit 4, flip the flag row. Schema changes are additive-only until exit 4. After that, fix forward. The runbook is in [Decide the CI and deploy pipeline](https://github.com/TFordyce/roll-for-brew/issues/493).
- **Migration numbers.** Check open PRs before picking one; a sibling PR may already claim the next number.

## Slice catalogue

Core slices run in order. Filler tickets run in parallel with them once slice 0 is done. Ticket links are the slice tickets; each one names its blockers.

| Slice | Ticket | Blocked by |
|---|---|---|
| 0 | [Port slice 0: C# solution, CI and Testcontainers harness](https://github.com/TFordyce/roll-for-brew/issues/503) | — |
| 0 | [Port slice 0: provision Cloud Run, the rfb_api role and the hosted checks](https://github.com/TFordyce/roll-for-brew/issues/504) | #503 |
| 0 | [Port slice 0: RoomStore, JWT auth and get_acting_as end to end behind port_flags](https://github.com/TFordyce/roll-for-brew/issues/505) | #503, #504 |
| 1 | [Port slice 1: RoundSnapshot loader, C# effect liveness and golden input fixtures](https://github.com/TFordyce/roll-for-brew/issues/506) | #505 |
| 1 | [Port slice 1: GET /rooms/{id}/view screen model](https://github.com/TFordyce/roll-for-brew/issues/507) | #506 |
| 1 | [Port slice 1: client room store, RoomScreen and interim enforceStall behind the room_view flag](https://github.com/TFordyce/roll-for-brew/issues/508) | #507 |
| 2a | [Port slice 2a: pure resolver helper modules in C#](https://github.com/TFordyce/roll-for-brew/issues/509) | #506 |
| 2a | [Port slice 2a: tea-maker selection module in C#](https://github.com/TFordyce/roll-for-brew/issues/510) | #509 |
| 2a | [Port slice 2a: Evaluate pipeline passes every golden](https://github.com/TFordyce/roll-for-brew/issues/511) | #510 |
| 2a | [Port slice 2a: AdvanceRound shadow over SQL advance_layer with diff alerting](https://github.com/TFordyce/roll-for-brew/issues/512) | #511, #508 |
| 2b | [Port slice 2b: Commit and persister make the C# evaluator authoritative](https://github.com/TFordyce/roll-for-brew/issues/513) | #512 |
| 2b | [Port slice 2b: recap preview, admin_backfill_round and deleting the SQL advancement subtree](https://github.com/TFordyce/roll-for-brew/issues/514) | #513 |
| 3 | [Port slice 3: round lifecycle and rolls](https://github.com/TFordyce/roll-for-brew/issues/515) | #514 |
| 4 | [Port slice 4: spell card draws](https://github.com/TFordyce/roll-for-brew/issues/516) | #515 |
| 5 | [Port slice 5: cast_spell_card](https://github.com/TFordyce/roll-for-brew/issues/517) | #516 |
| 5 | [Port slice 5: targets, ending effects, pending dice, Revolt picks and Courage Tokens](https://github.com/TFordyce/roll-for-brew/issues/518) | #517 |
| 6 | [Port slice 6: reaction windows](https://github.com/TFordyce/roll-for-brew/issues/519) | #518 |
| 7 | [Port slice 7: stall sweeps move into the API-side StallCheck](https://github.com/TFordyce/roll-for-brew/issues/520) | #519 |
| 8 | [Port slice 8: admin tools and the remaining SQL entry points](https://github.com/TFordyce/roll-for-brew/issues/521) | #520 |
| EF consolidation | [Port consolidation: Dapper out of RoomStore](https://github.com/TFordyce/roll-for-brew/issues/522) | #521 |
| EF consolidation | [Port consolidation: EF owns all DDL, revoke sweep and Data API off](https://github.com/TFordyce/roll-for-brew/issues/529) | #522, #523, #524, #525, #526, #527, #528 |
| Filler | [Port Filler: drink orders](https://github.com/TFordyce/roll-for-brew/issues/523) | #505 |
| Filler | [Port Filler: brew ratings](https://github.com/TFordyce/roll-for-brew/issues/524) | #505 |
| Filler | [Port Filler: spell card ratings and collection](https://github.com/TFordyce/roll-for-brew/issues/525) | #505 |
| Filler | [Port Filler: modifier adjustments](https://github.com/TFordyce/roll-for-brew/issues/526) | #505 |
| Filler | [Port Filler: room entry and setting Acting As](https://github.com/TFordyce/roll-for-brew/issues/527) | #505 |
| Filler | [Port Filler: server-rendered pages off PostgREST](https://github.com/TFordyce/roll-for-brew/issues/528) | #508 |

## Checks still owed

Each check has a home ticket. Record the result as a comment there. If a check fails, follow its fallback and don't redesign.

| Check | Fallback if it fails | Home |
|---|---|---|
| Cloud Run free tier (180k vCPU-s, 360k GiB-s, 2M req) and europe-west1 eligibility, from the pricing page | Azure Container Apps consumption, same image | slice 0 provisioning |
| Cloud Build free build-minutes (2,500/month listed, older copies said 120/day) | Actions build + push to Artifact Registry (needs WIF) | slice 0 provisioning |
| Supabase JWT signing mode (Project Settings > JWT Keys) | HS256: migrate to asymmetric keys first, or configure the shared secret | slice 0 provisioning |
| `rfb_api` logs in through Supavisor 6543 as `rfb_api.<ref>` | Session pooler 5432 for `rfb_api`, transaction-scoped statements unchanged | slice 0 provisioning |
| `BYPASSRLS` grant succeeds on hosted | Stop and ask the owner (ADR 0013's rejected alternatives were compared in [#496](https://github.com/TFordyce/roll-for-brew/issues/496)) | slice 0 provisioning |
| `realtime.send(..., private => false)` as `rfb_api` reaches a public `room:<id>` subscriber on hosted | REST broadcast after commit, not awaited, logged on failure (ADR 0011) | slice 0 provisioning |
| Real cold start of the R2R image | `min-instances=1` only if it hurts and the budget allows | slice 0 skeleton |
| Auth and Realtime keep working with the Data API off (test project) | Leave the Data API on with zero grants | EF consolidation, DDL + revocation |

## Retained SQL objects (end state)

These survive the port on purpose (ADR 0009):

- **Auth hooks and triggers:** `check_whitelist_before_user_created`, `enforce_whitelist_on_access_token`, trigger `on_auth_user_upsert_player` → `upsert_player_from_auth_user`.
- **Identity:** `current_player_id` and table `admin_acting_as`.
- **Projections:** `stats_*` views and `round_menu`, read by the API only after PostgREST closes.
- **Constraints:** data-shape `check` / `unique` / FK constraints only.
- **Tables:** `rooms.version`, `port_flags` (empty after the last slice, dropped in consolidation), and `port_shadow_runs` (dropped at 2b exit 4).

**`get_acting_as` / `set_acting_as`.** [#492](https://github.com/TFordyce/roll-for-brew/issues/492) listed them as retained identity plumbing. [#491](https://github.com/TFordyce/roll-for-brew/issues/491) and [#484](https://github.com/TFordyce/roll-for-brew/issues/484) port them as EF endpoints (slice 0 and Filler). This spec reconciles the two: the C# endpoints own them, and the SQL functions follow the normal exit-4 deletion. Only `current_player_id` and the `admin_acting_as` table carry Acting As at the end. The reason for keeping plumbing in SQL (it runs inside Supabase Auth while the API may be cold) doesn't apply to these two functions, which only the browser calls.

## Parked tickets

- [Layer readiness function](https://github.com/TFordyce/roll-for-brew/issues/465) and [Provisional Recap names which hold kinds it ignores](https://github.com/TFordyce/roll-for-brew/issues/466) fold into slice 2b.
- [Stall enforcement and home page read readiness holds](https://github.com/TFordyce/roll-for-brew/issues/467): the page-render half is slice 1, the sweep half is slice 7.
- [Trace steps become a discriminated union](https://github.com/TFordyce/roll-for-brew/issues/468) and [Step-kind table replaces per-kind recap logic](https://github.com/TFordyce/roll-for-brew/issues/469) stay parked until after the port. Trace jsonb is frozen until then.
- [Architecture deepening after spec #401](https://github.com/TFordyce/roll-for-brew/issues/462) closes once its children are resolved as above.
