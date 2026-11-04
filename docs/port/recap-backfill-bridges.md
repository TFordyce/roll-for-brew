# Round Recap and Round Backfill through the API (slice 2b-2, #548)

Merging this changes nothing for players. Both paths sit behind flags seeded off, and with them off the wrappers call the same rpcs as before.

| Flag | Wrapper | Off (seeded) | On |
|---|---|---|---|
| `getRoundRecap` | `getRoundRecap` | rpc `get_round_recap` | `GET /rounds/{id}/recap` |
| `adminBackfillRound` | `adminBackfillRound` | rpc `admin_backfill_round` | `POST /rounds/backfill` |

They are separate from `advanceRoundAuthoritative` and from each other. Each works whichever way the others are set, so a bad Recap can be rolled back without touching a round in play.

## Flip and rollback (human steps, outside play hours)

Precondition: the API is deployed with this branch and `0165` has run.

```sql
-- 1. Recap, Test Room first. RoundReveal passes the room id, so the room row applies there.
--    History has no Test Room rows, so it only ever sees the global row.
insert into public.port_flags (slice, room_id, enabled)
  select 'getRoundRecap', id, true from public.rooms where is_test;

-- 2. Recap, global. Check a live Provisional Recap and a past round in history.
update public.port_flags set enabled = true where slice = 'getRoundRecap' and room_id is null;

-- 3. Backfill. Global only: the wrapper has no room until the call makes one.
update public.port_flags set enabled = true where slice = 'adminBackfillRound' and room_id is null;
```

Record each flip on the ticket. #549 can't delete the SQL below until both flags have soaked as well as the advance flag.

**Rollback (instant, no deploy, safe at any time):**

```sql
update public.port_flags set enabled = false where slice in ('getRoundRecap', 'adminBackfillRound');
```

A Recap read writes nothing, so there is nothing to carry over. A round backfilled by C# has the same rows as one from SQL, and `rooms.version` just keeps its value.

## The Recap

`RoundRecapReader` runs in a `REPEATABLE READ READ ONLY` transaction (`RoomStore.ReadConsistent`), then `RoundRecapPreview.Build` works from the snapshot. The response carries the rpc's exact keys, so the TS parser reads either.

- **Provisional path:** `Evaluator.Preview` is `Evaluate` with no persister and `NoDiceRoller`. The savepoint dry run is not used on this path.
- **No writes, by construction:** the database refuses a write in this transaction. There is no version bump and no broadcast.
- **No lock:** `get_round_recap` took `for share` so its rolled-back writes could not deadlock finalization. A preview has no writes to order, so it never waits. One snapshot sees a concurrent finalize whole or not at all.

Two things the dry run did that `Evaluate` has to match, both only under `IsPreview`:

- **The Calami-Tea die is not rolled.** The step carries `rolled: null` and moves nothing, and a warded tick's `would_be_after` is 1 (`greatest(1, null)`).
- **A counter does not end a Roll Exemption until the window closes.** A resolving round's window has already closed, so only a preview can see the difference.

A round with everyone exempt and nobody immune previews no brewer, as SQL does. Phase 5 used to read `tied[0]` there and crash.

### Holds (#466)

`RoundRecapPreview.IgnoredHolds` is the one place naming what a Provisional Recap shows through. Pending die and deferred target hold it back.

| Kind | Why it's ignored |
|---|---|
| Revolt pick | On purpose: the resolver itself reports `pick_pending` |
| Compelled cast | An owed Action cast stops all rolling, so the roll count holds the Recap back first |

"Looks unreachable" is only nearly true. With everyone exempt, zero rolls satisfy the count, so an owed compelled cast does show through. Today's SQL does the same, so it is kept and pinned by a test (`An_owed_compelled_cast_shows_through_when_nobody_is_left_to_roll`).

## The Backfill

`RoundBackfillRules` is `admin_backfill_round`, statement for statement, in one transaction. Any refusal rolls back everything, including a room it just created. No spells and no `Evaluate`: a backfilled round has no Trace, today and after.

Each refusal's `detail` is SQL's message, because the form shows it. `backfillFailureMessage` reads the rpc's `RFBnn` and the API's problem code to the same sentence.

**Added on the API path:** one `rooms.version` bump, per the command contract. It sends no broadcast, as today.

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

**No new bridges.** This ticket calls no new SQL function and adds no grant. `get_round_recap` was never bridged: the view left it out, so there was no slice 1b grant to revoke. See `advance-round-bridges.md` for the list, which is unchanged.

## SQL-deletion list

**Empty on this ticket.** The rpcs are the rollback. For #549, once all three flags have soaked: `get_round_recap`, `_rr_resolve`, `admin_backfill_round`, and with it the last caller of the `resolve_round` boolean overload.

## Parity

Run against the real migrations, in a container, not the shared stack.

- `RoundRecapParityTests`: every golden scenario through both engines on one database, with the window closed, then open, then after SQL finalizes. Handwritten cases cover what the goldens never hold. Only the ids of rows SQL's dry run synthesizes and rolls back are masked, and every comparison also proves the state unchanged.
- `RoundBackfillParityTests`: each case through both engines from identical rows, comparing the error's code and message, or every row. Only `now()` and generated ids are masked.
- `RoundRecapBackfillHttpTests`: the HTTP seam.
