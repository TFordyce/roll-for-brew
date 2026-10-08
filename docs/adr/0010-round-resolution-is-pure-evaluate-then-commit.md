# Round resolution is a pure Evaluate then a Commit write list; advancement moves to C#

## Status

accepted — 2026-10-08. Decided on the C# port map ([#476](https://github.com/TFordyce/roll-for-brew/issues/476)): [Decide how to split pure evaluation from writes in _rr_resolve_eval](https://github.com/TFordyce/roll-for-brew/issues/483), [Decide how the API loads state without per-rule queries](https://github.com/TFordyce/roll-for-brew/issues/482), [Decide who runs stall enforcement and timers](https://github.com/TFordyce/roll-for-brew/issues/490).

**Supersedes ADR 0008** when port slice 2b cuts over (the SQL `advance_layer` / `finalize_layer` / `resolve_round` subtree is deleted). Until then ADR 0008 describes production. ADR 0005 (resolver semantics) is unchanged. ADR 0007 still holds (the roll row renders from resolver output), but its savepoint-rollback dry run is gone.

## Decision

- **State is one snapshot.** Each state-changing operation starts a transaction and takes `select ... for update` on the **round row**. It then loads one immutable, Room-keyed `RoundSnapshot` in a single batched round trip at READ COMMITTED. Draws keep `for update skip locked` claims. There are no advisory locks and no SERIALIZABLE. `spell_active_effects` stays stored rows, and "live as of round R" is a pure C# function over the snapshot. `room_players.modifier` and the Cast-Log flags are **output-only** caches: the domain never reads them as input.
- **`Evaluate(RoundSnapshot, IDieRoller) -> Resolution` is pure.** `Resolution` holds the Outcome, the Trace, the Resolution Summary and derived cast state. It runs as a phase pipeline over a private working copy, and phase order is pinned by a test. Preview is `Evaluate` with no persister, so the `RRDRY` savepoint trick disappears. Randomness comes in through `IDieRoller`, and existing tick rows in the snapshot mean only missing ticks roll.
- **`Commit(Resolution) -> Writes` is pure.** A dumb persister applies the write list. The `resolve_round` write overloads and `finalize_layer` collapse into one C# `AdvanceRound`.
- **Trace and Summary jsonb are frozen for the port.** Typed C# models serialise to exactly today's keys, step kinds and order. TS parsers stay unchanged, and goldens compare serialised JSON. Shape changes come after the port as a separate decision (parked `#468`, `#469`).
- **Tie layers port as-is** (early return, empty trace).
- **Stall enforcement is a lazy pure check.** `StallCheck(snapshot, dbNow)` runs on every snapshot load, with no scheduler. The room view carries `nextStallDeadline` for one client timer, and a GET may upgrade to a write when a stall fires.

## Considered

- **Keep advancement in locked SQL (ADR 0008) and port only evaluation.** Rejected: SQL cannot call C#, so either the evaluator stays in SQL or advancement moves with it. ADR 0008's real gains (one locked read, one transaction, exactly one resolution) carry over through the round-row lock.
- **Let the domain read stored caches and projections.** Rejected: that brings back the read-your-writes coupling that made `_rr_resolve_eval` 2,139 lines. Recompute-and-compare is cheap at tens of casts per room.
- **Change the Trace shape during the port.** Rejected: goldens are the parity oracle only while outputs stay byte-identical.
- **Scheduler-driven stall sweeps (Cloud Scheduler, `pg_cron`, Vercel cron).** Rejected: each would wake a scale-to-zero API on a cadence, and `pg_cron` calling SQL breaks "SQL never calls C#".

## Consequences

- The goldens in `tests/snapshots` are the single parity oracle for SQL and C#. The TS corpus emits an input fixture (the loaded snapshot) per scenario.
- `get_round_recap` becomes `Evaluate` preview at slice 2b.
- Derived `spell_casts` columns are still persisted for the UI. Goldens assert that stored equals recomputed.
