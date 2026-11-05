# Round advance: authoritative path and bridges (slice 2b-1, #547)

Two C# paths sit behind `POST /rounds/{id}/advance` and `/finalize`, and a flag picks between them on each call:

| `advanceRoundAuthoritative` | What runs | Who decides | Who broadcasts |
|---|---|---|---|
| off (seeded) | the evaluator shadow, `ShadowAdvance` (#546) | SQL | TS `httpSend`, as today |
| on | `AdvanceRound` through `RoomStore.Command` | C# | the API, in its transaction |

The `advanceRound` flag is separate. It only routes the TS wrappers to the API. It is on globally in production and means "shadow" until the new flag is flipped.

The flag is read in the call's own transaction, under the round lock, so the choice and the decision see the same moment and a call costs no extra transaction.

## Flip and rollback (human steps, outside play hours)

Precondition: the `advanceRound` flag is on, which it is. With it off the wrappers call `.rpc` and never reach this choice.

```sql
-- 1. Test Room first. Play rounds there, including a tie and a held reaction window.
insert into public.port_flags (slice, room_id, enabled)
  select 'advanceRoundAuthoritative', id, true from public.rooms where is_test;

-- 2. Then global. A room row beats the global row, so the Test Room row stays in charge of that room.
update public.port_flags set enabled = true
 where slice = 'advanceRoundAuthoritative' and room_id is null;
```

Record each flip on the slice's ticket. Spec exit gate: 5 play-days on globally with no rollback, then #549 may delete the SQL.

**Rollback (instant, no deploy, safe mid-round):**

```sql
update public.port_flags set enabled = false where slice = 'advanceRoundAuthoritative';
```

The next call runs the shadow, where SQL decides again. The SQL path carries on from anything C# wrote, including a tie's next Layer and a window C# opened. `rooms.version` keeps its last value, and the client store accepts equal versions.

If the API itself is broken, turn off `advanceRound` too, which sends the wrappers back to `.rpc`.

## Flow (one transaction per call)

1. Round-row `select … for update`, then the `RoundSnapshot` batch (`RoomStore.Command`).
2. `AdvanceRound.Decide` decides on the snapshot:
   - `LayerReadiness`: is the Layer complete, and if not, what holds it (#465).
   - `RollShim`: forced rerolls, flip, swap, chosen pair, with fresh d20s from `IDieRoller`.
   - `Evaluate` on the shimmed snapshot, then `Commit`, plus the Earl title endings.
3. `WritePersister` applies the writes, one statement per case.
4. Opening Layer 0's window takes two passes. The first runs the bridges below with `ReloadAfterWrite`, and the second reads the reloaded snapshot to see whether the window closed on the spot.
5. If anything was written, `rooms.version` is bumped once and every event is sent through `rfb_broadcast` with that version. No writes means no bump and no broadcast.
6. The response is the RPC's payload shape plus `version` when the call committed. The TS action skips its own `httpSend` when `version` is present. A noop has none, so TS still sends the unversioned `room-changed` for `revolt_pick_pending`.

An exception rolls the whole call back and the API returns an error: a resolver refusal (`resolve_round_*`, see `error-codes.md`) as its problem, anything else as `internal_error`. Unlike the shadow, the authoritative path has no SQL result to fall back on, so an `Evaluate` failure stops the round from advancing until the flag is rolled back.

## Bridge list

**Authoritative path:**

| Function | Grant | Called from | Goes when |
|---|---|---|---|
| `_forfeit_untargetable_compelled_reactions(uuid)` | migration `0164` | `AdvanceRound`, before opening the window | slice 6 |
| `open_reaction_window(uuid, integer)` | migration `0164` | `AdvanceRound` | slice 6 |
| `rfb_broadcast(text, text, jsonb)` | migration `0164` | `RoomStore.Command` | never: it is plumbing (ADR 0011) |

`resolve_round` (all overloads), `finalize_layer` and `advance_layer` are not called on this path.

**Shadow path only (flag off):** `advance_layer(uuid)` and `finalize_layer(uuid)`, granted by `0162`. They go with the shadow at #549.

## SQL-deletion list

**Empty on this ticket.** The SQL path is the rollback, so nothing is deleted or revoked. #549 takes the deletions once the soak has passed.

## Layer readiness (#465)

`LayerReadiness.Of` returns the expected rollers, who has rolled, and typed holds with who each waits on: pending die, deferred target, compelled cast, Revolt pick. `IsComplete`, `HoldReason` and `MayRoll` derive from it, so a new hold kind is one entry.

The SQL copies (`_layer_is_complete`, `is_expected_layer_roller`, `admin_proxy_roll`) stay as they are under the rules freeze. They go when their own slices port: roll submission and Proxy Roll in slice 3, and the rest at #549. The compelled-step disagreement is explained on `MayRoll`: an owed compelled Action cast stops all rolling, but those players stay in the expected set because the Layer still waits for them.

## Die coordination

* **Authoritative path:** every roll comes from `IDieRoller`, so nothing is left for SQL to roll. That covers the forced-reroll d20 and the Calami-Tea tick. The shadow's `rfb-shadow-skip` for un-applied roll transforms does not apply here, because the shim runs before `Evaluate`.
* **Shadow path, unchanged:** it pre-writes the synthesized casts so SQL replays C#'s rolls, deletes them if the call did not finalize, and skips the diff when the snapshot holds un-applied roll transforms. Tom accepted that blind spot on #546. The diffs stay at Error under `rfb-shadow-diff`.
* **Outside this path:** the other `random()` sites (cast and reaction rolls, player d20s, deck draws, pending dice) belong to slices 3 to 6.

## Parity

`AdvanceRoundParityTests` is the oracle. Each of the 72 golden scenarios, through each entry point, and the handwritten shim, advancement and hold scenarios run through SQL in one database and C# in another from identical rows. SQL rolls first and C# is scripted with SQL's dice. The payload and every row either engine can touch must match to the byte, with only `now()` timestamps and the random ids SQL gives rows it generates masked.

The snapshot loader gained two things for this path: `reaction_windows`, and the Brew IOU cast a round's `brewer_source_cast_id` points at, which a debt from another room needs.

It also leaves out every round's `resolution_trace` and `resolution_summary`. It spans the players' whole history and no rule reads them, while they were most of its bytes (3.2 MB to 503 KB at 300 past rounds). `RoundRecapReader` reads the one round's pair beside its room id, in the statement it already ran.

## The shadow in detail (#546)

Still live while `advanceRoundAuthoritative` is off, so kept as written for slice 2a. It goes with the shadow at #549.

### Shadow flow (one API transaction per advance call)

1. Round-row `select … for update` (`RoomStore.Advance`, ADR 0012's minimal write path).
2. `RoundSnapshot` loaded in one batched round trip.
3. `Evaluate(snapshot, roundId, dice)` — the shadow candidate, never served.
4. Pre-write the roll-bearing writes from `Commit(Resolution)`: the synthesized
   `spell_casts` rows (Saucerer's Apprentice copies and Calami-Tea dice ticks), with `seq`
   left identity-assigned in Commit order. This is the spec's "existing tick rows mean only
   missing ticks roll": the bridged resolver's own idempotency guards (`dice_tick` /
   `is_copy` per generation) then make SQL replay C#'s rolls instead of rolling fresh.
   The pre-writes are bridge fuel, not state — their lifecycle is
   **insert → bridge call → delete by the exact ids inserted, unless the call finalized**
   (below), all inside this one transaction. A warded tick is never pre-written: its roll
   is never applied (it collapses to `<rng>`), so SQL needs no replay, and pre-writing it
   would suppress SQL's own synthesis — whose `warded` step the candidate's trace does
   carry — for a false diff.
5. Bridge call (below) — SQL commits authoritative state and returns its outcome payload.
   When the outcome finalizes nothing — any `noop`, or `windowOpened` with a null
   `finalization` (the window stays open) — the pre-written rows are deleted again, so
   nothing synthesized survives into an open window: a ward cast as a reaction still
   negates a tick, and the window-close call re-runs `Evaluate` on the post-window
   snapshot and pre-writes fresh, exactly where the SQL-only path synthesizes.
6. Read back what SQL wrote (`resolution_trace` / `resolution_summary` jsonb and the
   resolution columns) and diff against the candidate through the goldens' normalized-JSON
   comparison (`Domain.TraceNormaliser`, shared with the golden renderer). The diff covers
   every finalization: `brewer`/`tie` at the payload's top level, and `advance_layer`'s
   nested `finalization` block when the window opened and closed on the spot (nobody
   eligible to react, so no player could cast into it — the candidate evaluated the same
   state SQL resolves). A non-finalizing outcome has nothing to examine: no diff, no skip.
7. Return SQL's payload unchanged. Broadcasts stay TS-side, exactly as today.

### Die-coordination survey (resolver SQL `random()` sites, latest definitions)

Category **(a) — persisted, pre-written from C#** (no fresh roll can diverge):

* `_rr_resolve_eval` Phase 3-pre, the Calami-Tea `per_round_dice_tick` synthesis
  (latest: `0149`, ~line 1253): rolls `floor(random()*die+1)` and persists it in the
  inserted `spell_casts` row (`effect_params.rolled` + `cast_inputs.roll_transform.rolled`),
  idempotent per `(round, source_cast, generation)`. The shadow pre-writes exactly that row
  (C#'s deterministic `rfb-dice-tick:{source}:{gen}` id), so SQL's exists-check skips and
  re-reads C#'s roll. Seam 2 asserts the row count, the deterministic id and the scripted
  value.
* Copy synthesis (Phase 0a) draws no fresh RNG (copied verbatim from
  `cast_inputs.copy_inputs`), and is pre-written for the same reason: one seq order.

Category **(b) — rolled fresh by SQL with no C# counterpart** (diff normalization, never
silently ignored):

* `apply_forced_reroll`'s d20 (called from `finalize_layer`'s eager roll-input shim,
  together with the transform-recording for `roll_flip` / `roll_swap` /
  `roll_pair_transform`). The shim runs inside the bridge, **after** the candidate was
  evaluated; `Evaluate` only applies transforms already recorded on casts
  (`Phase3RollInputs` skips casts without `cast_inputs.roll_transform`), so the candidate
  cannot carry the shim's outcomes. The shadow therefore **skips the diff** and logs
  `rfb-shadow-skip` (reason `unapplied roll-transform casts`) whenever the snapshot holds
  any cast of those kinds without a recorded transform. The same guard covers
  `advance_layer`'s attach step (`attach_pre_roll_forced_reroll_casts` /
  `attach_pre_roll_roll_pair_transform_casts`), which stamps exactly those kinds with the
  new window's id right before the shim transforms them. When slice 2b ports the shim into
  the C# `AdvanceRound` (fresh rolls via `IDieRoller`), the skip and this paragraph go.

Category **(c) — outside the advance path** (cannot reach the bridges; no normalization
needed): cast-time rolls in `cast_spell_card` (WILD d6 branch, the `order by random()`
other-player pick, CHOSEN_PLAYERS dice totals; `0150`), reaction rolls in
`cast_reaction_spell_card` (table dice totals, the contested-negate d20; `0148`), the
player d20s in `submit_roll` / `submit_roll_as`, deck draws, `close_round`'s placeholder
fan-out, pending-die resolution, and the stall/report reads. These are slice 3–6 entry
points, not callees of `advance_layer` / `finalize_layer`.

### The nested finalization is comparable (SQL trace, #546)

`advance_layer`'s `windowOpened` + `window_closed: true` outcome opens the window, closes
it and finalizes in one call, so the diff runs against the nested `finalization` block. The
SQL trace that decided the candidate is comparable — nothing window-time can reach the
resolution:

* `open_reaction_window` inserts the window, attaches pre-roll
  `forced_reroll`/`roll_pair_transform` casts, counts eligible reaction holders and — at
  zero — closes immediately, all inside the one locked call. No player can cast into a
  window that never sits open.
* The attach step stamps only shim-guarded kinds, so whenever it mutates anything the
  `rfb-shadow-skip` guard above has already skipped the diff.
* `_forfeit_untargetable_compelled_reactions` cannot fire here: an outstanding compelled
  Reaction cast implies its holder still holds the Reaction-timed card, and any held
  Reaction-timed card keeps the window open — not the nested path.
* The window row itself is resolution-invisible: the only resolver read of
  `spell_reaction_windows` is the Broken-Biscuit `lowest_gains_highest_modifier` join on
  `casts.reaction_window_id` (the C# side gates the same way), and a brand-new window has
  no casts stamped with its id — only Reaction casts carry window ids.

### Deliberately out of the diff

* The payload's `rolls` array (post-shim final rolls) — the candidate has no counterpart.
* `replay_pending` — follows from a surviving `round_replay` cast, which the `Resolution`
  does not carry; any real disagreement behind it fires via negation or the trace.
* `rounds.brewer_source` is compared as the brewer-record source only
  (`'brew_iou'`/`'brew_debt'`); the resolver's `'default'` label is not persisted.
* A tie payload carries the layer SQL advanced to; the candidate the layer that tied
  (compared as `candidate.Layer + 1`).
* RNG-drawn trace values collapse to `<rng>` and ids to stable aliases — the same
  normalization the goldens use, so a clean shadow pass means the goldens' oracle agrees.
