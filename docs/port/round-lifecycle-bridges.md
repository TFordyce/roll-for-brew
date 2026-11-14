# Round lifecycle commands: flags and bridges (slice 3a, #550)

Nine commands run through the C# API, each behind its own flag: starting a round, declaring in (and Late Declare), withdrawing, closing, cancelling, excluding a Participant, and confirming or declining a Round replay. Merging changes nothing for players: with no row, or the row off, every wrapper keeps its SQL `.rpc`.

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

All nine rows are seeded off by migration `0166`. Every endpoint returns `{ version }` (`startRound` also `roundId`): the bumped `rooms.version`, or null when the call changed nothing (declaring twice, cancelling a resolved round, excluding someone already excluded, declining with nothing pending). The writes and the `room-changed` broadcast share one transaction with the round-row lock (ADR 0011, ADR 0012), and a dropped send rolls the command back (`Announce.Required`): a start, close or exclusion nobody hears about leaves the table waiting on a state it cannot see.

## Flip and rollback (human steps, outside play hours)

Preconditions: API deployed with this slice, `NEXT_PUBLIC_API_URL` set, API `CORS_ORIGINS` includes the app origin. Round-scoped flags honour a room row, so the Test Room goes first. `startRound` takes its room from the call, so it only sees a room row when the caller passes a room id (the Test Room page does; the home page does not, so the Test Room row never moves home-page starts).

```sql
-- 1. Test Room first, one slice at a time. Play a round there: start, declare, withdraw, close, a stalled cancel, a Time for Brew scrap.
insert into public.port_flags (slice, room_id, enabled)
  select s, r.id, true
    from unnest(array['startRound', 'declareIn', 'withdrawDeclaration', 'closeRound']) as s
   cross join public.rooms r where r.is_test
on conflict (slice, room_id) do update set enabled = true;

-- 2. Then global. A room row beats the global row.
update public.port_flags set enabled = true
 where room_id is null and slice in (
   'startRound', 'declareIn', 'declareInLate', 'withdrawDeclaration', 'closeRound',
   'cancelRound', 'excludeRoundParticipant', 'confirmRoundReplay', 'declineRoundReplay');
```

Rollback (instant, no deploy, safe mid-round: both paths write the same rows):

```sql
update public.port_flags set enabled = false
 where slice in ('startRound', 'declareIn', 'declareInLate', 'withdrawDeclaration', 'closeRound',
                 'cancelRound', 'excludeRoundParticipant', 'confirmRoundReplay', 'declineRoundReplay');
```

Record each flip on #550. The soak (5 play-days on globally, no rollback) is a separate human-gated step.

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

**Empty on this ticket.** The SQL functions are the rollback, so nothing is dropped or revoked. After the soak, remove: the nine functions in the table above (with their `authenticated` grants), the `.rpc` branches in `src/lib/supabase/rounds.ts`, `roundReplay.ts` and `stall.ts`, the nine `port_flags` rows, and the SQL-side tests that call them directly (`tests/integration`). `auto_decline_stalled_round_replays` stays until the stall slice. `round_has_any_rolls` is a read and stays.

## Known differences from the SQL path

* Unchanged TS actions still call `broadcastRoomChanged` after each command. On the API path that is a second, unversioned `room-changed`; the client store accepts it. Remove those calls with the `.rpc` branches.
* `declare_in*` and `withdraw_declaration` used to say "round not found" or "not in this room" as a plain exception; they are now `round_not_found` (404), `not_present_in_room` (403), `starter_cannot_withdraw` (422), `close_not_starter` (403), `close_too_few_declared` (422), `no_room_today` (404) and `round_already_active` (409). See `error-codes.md`.
* `cancel_round` and `exclude_round_participant` check no actor, as before: any signed-in player can call them. They only apply a decision the caller already made.
