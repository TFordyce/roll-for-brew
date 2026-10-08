# Rules engine ported to a C# API by a top-down strangler; no rules logic left in Postgres

## Status

accepted — 2026-10-08. Decided on the C# port map ([#476](https://github.com/TFordyce/roll-for-brew/issues/476)): [Decide the strangler seam and slice order](https://github.com/TFordyce/roll-for-brew/issues/484), [Decide the end state of rules logic in Postgres](https://github.com/TFordyce/roll-for-brew/issues/492), [Decide how much new SQL feature work is allowed during the port](https://github.com/TFordyce/roll-for-brew/issues/479).
**Supersedes ADR 0006** once port slice 8 reaches exit 4 (its SQL is deleted). Until then 0006 governs the functions still in `db/sql`.

## Decision

The plpgsql rules engine (about 180 functions, 15k lines) moves to an ASP.NET Core API with a pure C# domain library. Supabase stays as Postgres, Auth and Realtime. The move is a **strangler by RPC entry point, top-down**:

- A slice ports one or more **entry points** (functions nothing else in SQL calls). The TS wrapper switches from `.rpc` to the API, and the C# endpoint owns the whole flow beneath it.
- **C# may call SQL; SQL never calls C#.** A SQL function is deleted only when its last SQL caller is gone.
- **Pure or read helpers** that unported SQL still needs (`_rr_active_effects_as_of`, `_rr_active_ward_gate`, `_compelled_outstanding`, ...) get a C# copy. The rules freeze plus a golden per helper keep the two copies in step.
- **Write helpers** may be called from C# inside the API transaction as **bridges**. Each slice ticket lists its bridges, and a later slice removes them.
- A **`port_flags`** table (slice key + optional `room_id`) decides per request whether a TS wrapper calls SQL or the API. Rollout is test room, then all rooms. Rollback is flipping the row.
- The evaluator ships first as a **shadow** (slice 2a). C# evaluates beside the SQL commit, and diffs are logged, never served. It becomes authoritative only after 10 consecutive play-days with zero diffs.
- Schema changes are **additive-only** until a slice's SQL is deleted, so SQL can still read whatever C# writes during rollback.
- **Rules freeze.** No new cards or rules during the port. A SQL bug fix ships with a parity snapshot, and inside a slice's freeze window it is mirrored into C#.

**End state: zero rules logic in Postgres.** If a function needs the rules glossary to explain a decision it makes, it belongs in C#. Row locks and batched reads become inline SQL in the API's data module, not stored functions. These stay on purpose:

- **Identity plumbing** (`check_whitelist_before_user_created`, `enforce_whitelist_on_access_token`, `on_auth_user_upsert_player`, `current_player_id`, `get_acting_as` / `set_acting_as`) stays plpgsql, because it runs inside Supabase Auth's flow while the API may be scaled to zero.
- **Data-shape constraints** stay (`check`, `unique`, FK). Game-rule invariants do not.
- **`stats_*` views and `round_menu`** stay as read-only projections of stored outcomes.

After slice 8, `db/sql/` and its build and verify scripts are deleted. The surviving identity functions go back to hand-authored migrations (EF-scripted after consolidation, ADR 0012).

## Considered

- **Leaf-first (bottom-up) porting**, following the call-graph levels. Rejected: plpgsql cannot call C# within the transaction or the latency budget, so every ported leaf would be stranded under SQL callers.
- **Big-bang rewrite.** Rejected: the game is played every weekday, so every cutover must be zero-downtime and reversible.
- **Keep locks and integrity rules as stored functions after the port.** Rejected: that leaves two homes for rules logic. Shape constraints are enough as the last line of defence.
- **Move the data layer to Azure SQL / Entra at the same time.** Rejected for this effort. Revisit only if Supabase stops fitting: free-tier pausing or limits hurt weekday play, or the bill passes the £0–5/month ceiling.

## Consequences

- During the port, some pure helpers exist in both SQL and C#. Goldens and the rules freeze are the only things holding them together. That is why the freeze is a hard rule.
- Every write that C# makes during a soak must stay readable by the SQL path, which costs some schema elegance until exit 4.
- `#465` and `#466` fold into slice 2b. `#467` splits between slices 1 and 7. `#468` and `#469` stay parked as post-port follow-ups.
