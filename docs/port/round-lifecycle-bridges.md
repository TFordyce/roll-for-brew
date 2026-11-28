# Round lifecycle commands: flags and bridges (slice 3a, #550)

Nine commands run through the C# API: starting a round, declaring in (and Late Declare), withdrawing, closing, cancelling, excluding a Participant, and confirming or declining a Round replay. Since #552 the TS wrappers in `rounds.ts`, `roundReplay.ts` and `stall.ts` call the API only and read no flag. The flag rows and SQL functions below stay until the #552 drop PR, but nothing in the app reads or calls them.

| Flag (`port_flags.slice`) | Endpoint | SQL it replaces |
|---|---|---|
| `startRound` | `POST /rounds` | `start_round(uuid)` |
| `declareIn` | `POST /rounds/{id}/declaration` | `declare_in(uuid)` |
| `declareInLate` | `POST /rounds/{id}/declaration/late` | `declare_in_late(uuid)` |
| `withdrawDeclaration` | `DELETE /rounds/{id}/declaration` | `withdraw_declaration(uuid)` |
| `closeRound` | `POST /rounds/{id}/close` | `close_round(uuid)` |
| `cancelRound` | `POST /rounds/{id}/cancel` | `cancel_round(uuid)` |
| `excludeRoundParticipant` | `POST /rounds/{id}/exclusions` | `exclude_round_participant(uuid, text, integer)` |
| `confirmRoundReplay` | `POST /rounds/{id}/replay/confirm` | `confirm_round_replay(uuid)` |
| `declineRoundReplay` | `POST /rounds/{id}/replay/decline` | `decline_round_replay(uuid)` |

Migration `0166` seeded all nine rows off. Every endpoint returns `{ version }` (`startRound` also `roundId`): the bumped `rooms.version`, or null when the call changed nothing (declaring twice, cancelling a resolved round, excluding someone already excluded, declining with nothing pending). The writes and the `room-changed` broadcast share one transaction with the round-row lock (ADR 0011, ADR 0012), and a dropped send rolls the command back (`Announce.Required`): a start, close or exclusion nobody hears about leaves the table waiting on a state it cannot see.

## Flip history

Flipped Test Room first, then global, and soaked 5 play-days with no rollback (recorded on #550 and #552). There is no rollback now: the wrappers no longer read the flags, so turning a row off changes nothing. Recovering the SQL path means reverting the #552 code-half PR and deploying.

## What C# decides, and the bridges

C# owns every check and write the SQL did: state and race checks, the starter and roster rules, Late Declare's "closed and nobody has rolled" window, idempotent cancel/exclude/decline, the stale replay sweep in `start_round`, and the debt-round test that skips fixing the compelled set (`Rules.BrewDebtDue`, already in C# for advancement). `close_round`'s "fix the compelled set" and the replay scrap itself are rules logic that other slices own, so they stay in SQL as bridges for now.

| Function | Grant | Called from | Goes when |
|---|---|---|---|
| `_fan_out_table_placeholder_casts(uuid, uuid)` | migration `0166` | `RoundLifecycle.Close` | casting slice |
| `_fix_compelled_set(uuid)` | migration `0166` | `RoundLifecycle.Close` (not for a debt round) | compelled-cast slice |
| `_forfeit_compelled_card(uuid, text, text)` | migration `0166` | `RoundLifecycle.Exclude` (Layer 0 only) | compelled-cast slice |
| `_rr_scrap_round(uuid)` | migration `0166` | `RoundLifecycle.ConfirmReplay` | replay slice |
| `rfb_broadcast(text, text, jsonb)` | migration `0164` | `RoomStore` | never: plumbing (ADR 0011) |

## SQL-deletion list

The soak passed (16–20 Nov, confirmed on #552). The #552 code half removed the `.rpc` branches and the TS actions' extra `broadcastRoomChanged` after each command. The #552 drop PR removes the nine functions in the table above (with their `authenticated` grants), the nine `port_flags` rows, and the SQL-side tests that call them directly (`tests/integration`). `auto_decline_stalled_round_replays` stays until the stall slice. `round_has_any_rolls` is a read and stays.

## Known differences from the SQL path

* `declare_in*` and `withdraw_declaration` used to say "round not found" or "not in this room" as a plain exception; they are now `round_not_found` (404), `not_present_in_room` (403), `starter_cannot_withdraw` (422), `close_not_starter` (403), `close_too_few_declared` (422), `no_room_today` (404) and `round_already_active` (409). See `error-codes.md`.
* `cancel_round` and `exclude_round_participant` check no actor, as before: any signed-in player can call them. They only apply a decision the caller already made.
