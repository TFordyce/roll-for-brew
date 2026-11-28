# Roll submission: flags and bridges (slice 3b, #551)

Five commands run through the C# API: the player's auto roll, the player's manual roll, the Test Room's two `_as` twins, and the admin's Proxy Roll. Since #552 the TS wrappers in `rolls.ts` call the API only, and the SQL functions and flag rows below are deleted (migration `0169`).

| Flag (`port_flags.slice`) | Endpoint | SQL it replaces |
|---|---|---|
| `submitRoll` | `POST /rounds/{id}/rolls` | `submit_roll(uuid)` |
| `submitManualRoll` | `POST /rounds/{id}/rolls/manual` | `submit_manual_roll(uuid, integer)` |
| `submitRollAs` | `POST /rounds/{id}/rolls/as` | `submit_roll_as(uuid, text)` |
| `submitManualRollAs` | `POST /rounds/{id}/rolls/manual/as` | `submit_manual_roll_as(uuid, text, integer)` |
| `adminProxyRoll` | `POST /rounds/{id}/rolls/proxy` | `admin_proxy_roll(uuid, text, integer)` |

Migration `0167` seeded all five rows off. Every endpoint returns `{ value, version }`: the number recorded (the server's die for an auto roll, the entered number otherwise) and the bumped `rooms.version`. The write and the `room-changed` broadcast share one transaction with the round-row lock (ADR 0011, ADR 0012), and a dropped send rolls the roll back (`Announce.Required`).

## Advancing a completed Layer

The "same flow" is the TS action flow, unchanged: each action submits the roll, then records the nat 1 / nat 20 pending draw, then calls `advanceRound(…, "layerRolled")`, which is already the API's `AdvanceRound` (#549). The advance stays a separate call, not folded into the roll's transaction, because the pending draw has to be recorded before a resolving advance, as it always was. `RollSubmission` takes no part in deciding a Layer is complete; `AdvanceRound` still does.

## Flip history

Flipped Test Room first, then global, and soaked 5 play-days with no rollback (recorded on #551 and #552). There is no rollback: the SQL path is deleted.

## What C# decides, and the bridges

C# owns every check and write the five SQL functions did: round state, the expected-roller rule and the Compelled Cast hold (`LayerReadiness`), the Test Room and admin rules, the d20 (and the second die), advantage and disadvantage including the conditional Gambler's Infusion branch and the rest-of-day persistent kind, Fixed Roll, the roll-domain ward gate (shared with `RollShim` through `WardGate`), recording each roll transform on its casts, and the Proxy Roll's seat and declaration.

One piece of rules logic stays in SQL as a bridge, because it spends a Marked for Brew mark and takes advisory locks:

| Function | Grant | Called from | Goes when |
|---|---|---|---|
| `_apply_crit_redirect(uuid, text)` | migration `0167` | `RecordCritDraw` (Proxy Roll nat 1 / nat 20) | crit-redirect slice |

It is an invoker function, so `rfb_api` also needs `_rr_active_effects_as_of(uuid, uuid)` and `_rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz)`, granted in `0167`. Revoke all three with the bridge.

## SQL deleted at #552 (migration 0169)

The soak passed (16–20 Nov, confirmed on #552). #631 removed the `.rpc` branches in `src/lib/supabase/rolls.ts`. Migration `0169` drops the five functions in the table above, their `port_flags` rows, and the helpers only they reached: `_rr_apply_fixed_roll`, `is_expected_layer_roller` and `_compelled_cast_step_open`. The ward gate `_rr_active_ward_gate` stays, because the reaction-window shims still read it until the casting slice.

## Known differences from the SQL path

* A second roll by a player who already rolled this Layer is `not_expected_roller` (409), which the TS actions treat as a lost race. SQL let the `rolls` primary key refuse it (`23505`), which the actions rethrew.
* `submit_roll_as` and the `_as` and Proxy admin checks, the Test Room check, the value range, a missing round and a missing Proxy target were plain exceptions. They are now `admin_required` (403), `round_not_in_test_room` (422), `roll_value_out_of_range` (400), `round_not_found` (404) and `target_player_not_found` (404). See `error-codes.md`.
* The auto roll draws its d20 from the API's `Random.Shared` instead of Postgres `random()`. Nothing depends on the generator.
* On the SQL path a roll sent no `room-changed` of its own (the next advance, or the page refetch, told the table). On the API path every roll sends one, versioned.
