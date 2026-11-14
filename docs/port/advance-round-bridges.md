# Round advance: the C# path and its bridges (slice 2b-1, #547)

`POST /rounds/{id}/advance` and `/finalize` run `AdvanceRound` through `RoomStore.Command`. C# decides and broadcasts; the TS wrappers (`advanceLayer`, `finalizeLayer`) only call the API and reshape its payload.

**Retired flags (#549).** The `advanceRound` and `advanceRoundAuthoritative` rows, the evaluator shadow (`ShadowAdvance`, #546) and the `.rpc` branch in the wrappers are gone. The shadow existed to compare C# with `advance_layer` and `finalize_layer`, and those are deleted with it. There is no rollback flag: to roll back, revert the retirement PRs. The soak (7 to 13 Nov 2026, five play-days, no rollback) is recorded on #547 and #549.

## Flow (one transaction per call)

1. Round-row `select … for update`, then the `RoundSnapshot` batch (`RoomStore.Command`).
2. `AdvanceRound.Decide` decides on the snapshot:
   - `LayerReadiness`: is the Layer complete, and if not, what holds it (#465).
   - `RollShim`: forced rerolls, flip, swap, chosen pair, with fresh d20s from `IDieRoller`.
   - `Evaluate` on the shimmed snapshot, then `Commit`, plus the Earl title endings.
3. `WritePersister` applies the writes, one statement per case.
4. Opening Layer 0's window takes two passes. The first runs the bridges below with `ReloadAfterWrite`, and the second reads the reloaded snapshot to see whether the window closed on the spot.
5. If anything was written, `rooms.version` is bumped once and every event is sent through `rfb_broadcast` with that version. No writes means no bump and no broadcast.
6. The response is the outcome payload plus `version` when the call committed. `version` sits beside the payload's own keys, not in a wrapper. The TS action skips its own `httpSend` when `version` is present. A noop has none, so TS still sends the unversioned `room-changed` for `revolt_pick_pending`.

An exception rolls the whole call back and the API returns an error: a resolver refusal (`resolve_round_*`, see `error-codes.md`) as its problem, anything else as `internal_error`. Unlike the shadow, the authoritative path has no SQL result to fall back on, so an `Evaluate` failure stops the round from advancing until the flag is rolled back.

## Bridge list

| Function | Grant | Called from | Goes when |
|---|---|---|---|
| `_forfeit_untargetable_compelled_reactions(uuid)` | migration `0164` | `AdvanceRound`, before opening the window | slice 6 |
| `open_reaction_window(uuid, integer)` | migration `0164` | `AdvanceRound` | slice 6 |
| `rfb_broadcast(text, text, jsonb)` | migration `0164` | `RoomStore.Command` | never: it is plumbing (ADR 0011) |

## SQL deleted at #549

`advance_layer`, `finalize_layer`, every `resolve_round` overload, `_rr_resolve` and `_rr_resolve_eval`, and the helpers they alone called: the Phase 5 selection and its steps, the trace and heist helpers, `_layer_is_complete`, `_layer_rolls_json`, the roll shims (`apply_roll_flip`, `apply_roll_swap`, `apply_roll_pair_transform`, `apply_forced_reroll`) and `record_pending_round_replay`. The migration drops them by name, so it lists the whole set.

## Layer readiness (#465)

`LayerReadiness.Of` returns the expected rollers, who has rolled, and typed holds with who each waits on: pending die, deferred target, compelled cast, Revolt pick. `IsComplete`, `HoldReason` and `MayRoll` derive from it, so a new hold kind is one entry.

The SQL copies `is_expected_layer_roller` and `admin_proxy_roll` stay as they are under the rules freeze, and go when their own slices port (roll submission and Proxy Roll in slice 3). `_layer_is_complete` went at #549.

## Die coordination

Every roll on this path comes from `IDieRoller`, so nothing is left for SQL to roll. That covers the forced-reroll d20 and the Calami-Tea tick. The other `random()` sites (cast and reaction rolls, player d20s, deck draws, pending dice) belong to slices 3 to 6.

## Tests

The 103 golden scenarios in `tests/snapshots` are the evaluator's oracle (`GoldenEvaluateTests`). Before #549 they were also run through SQL and C# from identical rows (`AdvanceRoundParityTests`); that comparison ended with the SQL. `AdvanceRoundScenarioTests` keeps the handwritten shim, advancement, hold and gap scenarios as C#-only tests, and `RoundAdvanceHttpTests` covers the HTTP seam.

The snapshot loader gained two things for this path: `reaction_windows`, and the Brew IOU cast a round's `brewer_source_cast_id` points at, which a debt from another room needs.

It also leaves out every round's `resolution_trace` and `resolution_summary`. It spans the players' whole history and no rule reads them, while they were most of its bytes (3.2 MB to 503 KB at 300 past rounds). `RoundRecapReader` reads the one round's pair beside its room id, in the statement it already ran.
