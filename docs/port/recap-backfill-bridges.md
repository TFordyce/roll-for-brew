# Round Recap and Round Backfill through the API (slice 2b-2, #548)

| Wrapper | Endpoint |
|---|---|
| `getRoundRecap` | `GET /rounds/{id}/recap` |
| `adminBackfillRound` | `POST /rounds/backfill` |

**Retired flags (#549).** The `getRoundRecap` and `adminBackfillRound` rows and the wrappers' `.rpc` branches are gone, and `get_round_recap`, `_rr_resolve` and `admin_backfill_round` are deleted. The soak (7 to 13 Nov 2026, five play-days, no rollback) is recorded on #548 and #549. There is no rollback flag: to roll back, revert the retirement PRs.

## The Recap

`RoundRecapReader` runs in a `REPEATABLE READ READ ONLY` transaction (`RoomStore.Read`), then `RoundRecapPreview.Build` works from the snapshot. The response carries the rpc's exact keys, so the TS parser reads either.

- **Provisional path:** `Evaluator.Preview` is `Evaluate` with no persister and `NoDiceRoller`. The savepoint dry run is not used on this path.
- **No writes, by construction:** the database refuses a write in this transaction. There is no version bump and no broadcast.
- **No lock:** `get_round_recap` took `for share` so its rolled-back writes could not deadlock finalization. A preview has no writes to order, so it never waits. One snapshot sees a concurrent finalize whole or not at all.

Two things the dry run did that `Evaluate` has to match, both only under `IsPreview`:

- **The Calami-Tea die is not rolled.** The step carries `rolled: null` and moves nothing, and a warded tick's `would_be_after` is 1 (`greatest(1, null)`).
- **A counter does not end a Roll Exemption until the window closes.** A finalizing round's window has already closed, so only a preview can see the difference.

A round with everyone exempt and nobody immune previews no Tea Maker, as SQL does. Phase 5 used to read `tied[0]` there and crash.

### Holds (#466)

`RoundRecapPreview.IgnoredHolds` is the one place naming what a Provisional Recap shows through. Pending die and deferred target hold it back.

| Kind | Why it's ignored |
|---|---|
| Revolt pick | On purpose: the resolver itself reports `pick_pending` |
| Compelled cast | An owed Action cast stops all rolling, so the roll count holds the Recap back first |

"Looks unreachable" is only nearly true. With everyone exempt, zero rolls satisfy the count, so an owed compelled cast does show through. Today's SQL does the same, so it is kept and pinned by a test (`An_owed_compelled_cast_shows_through_when_nobody_is_left_to_roll`).

## The Backfill

`RoundBackfillRules` is `admin_backfill_round`, statement for statement, in one transaction. Any refusal rolls back everything, including a room it just created. No spells and no `Evaluate`: a backfilled round has no Trace, today and after.

Each refusal's `detail` is SQL's message, because the form shows it. `backfillFailureMessage` turns the API's problem code into the sentence.

**Added on the API path:** one `rooms.version` bump and a `room-changed` carrying it, sent in the transaction (spec #533, 7 Nov 2026: visible writes announce themselves). SQL sent nothing. It is a `Filler` writing core tables with raw SQL, which ADR 0012 records, and its `room_players.modifier` read is SQL parity, which ADR 0010 records.

### The guards `AdvanceRound` dropped (#547)

Checked against this caller, because backfill reaches `resolve_round` and `advance_round_layer` differently:

| Guard | From backfill | In C# |
|---|---|---|
| `advance_round_layer`: tied player did not roll | **Reachable.** `array_length('{}', 1)` is null, so an empty roster passes RFB34 and the roster checks | Kept, `backfill_not_resolvable` |
| `resolve_round`: brewer is not a participant | **Reachable**, the same way | Kept, `backfill_not_resolvable` |
| `resolve_round`: not all participants have rolled | Unreachable: every expected player's roll was just inserted, and an unknown player has already failed its foreign key | Dropped |
| `resolve_round`: cups must equal participants | Unreachable: cups is the roster's size, and a repeated id fails `round_participants`' key first | Dropped |
| `advance_round_layer`: fewer than 2 tied | Unreachable: this branch has at least 2 | Dropped |
| Round not found, or not closed | Unreachable: this transaction just created it, and nobody else can see it | Dropped |

A Brew Debt does not reach the tied-player check either. `_brew_debt_due` needs a round with no Layer 0 roll, and these rolls are in first. `A_brew_debt_does_not_stop_a_debtor_tying_or_become_the_outcome` pins it.

The form never sends an empty roster: it requires 2 players.

## Bridge list

**No bridges.** The Recap and the Backfill call no SQL function.

## Tests

- `RoundRecapTests`: the Recap read through C# (provisional and stored states, refusals), each proving the read wrote nothing. They began as comparisons with `get_round_recap`.
- `RoundBackfillTests`: every refusal leaves the database untouched; each accepted round resolves to the asserted brewer and layer. They began as comparisons with `admin_backfill_round`.
- `RoundRecapBackfillHttpTests`: the HTTP seam.
