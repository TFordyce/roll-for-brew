# Room view read bridges (slice 1b, #538)

`GET /rooms/{roomId}/view` returns `{ version, room, viewer }` for the **effective player** (Acting As resolved by SQL `current_player_id(null, room)` from the validated JWT; nothing in the request can name another player). It is `Cache-Control: no-store`. This file is the bridge list the ticket asks for (the issue itself cannot be edited by the implementing agent). Keep it current: **revoke the `rfb_api` EXECUTE grant (migration `0159_rooms_version.sql` grants them) and delete the row as each function is ported to C#.**

## How the view is built (three statements, one READ ONLY transaction)

1. `RoundSnapshot` (slice 0c). Also carries `rooms.version` (added by `0159`), so version and state come from one statement.
2. **Extras**: direct table / view reads that are not in the snapshot (`orders`, `round_menu`, `brew_ratings`, `player_settings`, `pending_round_replay`, `players`).
3. **Bridges**: the SQL read functions below, called as the viewer (claims GUC), so hands, pending draws and eligibility stay scoped to the viewer inside SQL.

The pure `RoomViewProjector` (Domain) turns those into the view. All derivations and secrecy live there and are unit-tested.

## Read bridges (still SQL, EXECUTE granted to `rfb_api`)

| Function | Feeds | Gate in the projection |
|---|---|---|
| `get_my_spell_cards(room)` | `viewer.heldCards`, `heldReactionCard` | viewer-only (SQL) |
| `get_my_pending_spell_draw()` | `viewer.pendingSpellDraw` | viewer-only (SQL) |
| `get_my_pending_casts(round)` | `viewer.pendingCasts` | closed round |
| `get_my_pending_spell_dice(round)` | `viewer.pendingSpellDice` | active round |
| `get_my_compelled_cast(round)` | `viewer.compelledCast.mine`, `reaction.compelled` | closed layer 0 |
| `get_compelled_cast_step(round)` | `viewer.compelledCast.waitingOnOthers`, turn to roll, stall clock | closed |
| `get_tea_party_revolt_picker(round)` | `viewer.teaPartyRevoltPickerId` | closed layer 0 |
| `get_dispellable_active_effects(round)` | `viewer.dispellableEffects` | open round, or compelled Action cast |
| `get_heist_targets(round)` | `viewer.heistTargetIds` | as above, and Tea Heist in hand |
| `get_last_drip_preview(round)` | `viewer.lastDripPreview` | as above, and Last Drip in hand |
| `get_open_reaction_window(round)` | `viewer.reaction` | closed round |
| `get_reaction_stack(round)` | `viewer.reaction.stack` | open window |
| `get_reaction_window_pending_players(round)` | `viewer.reaction.pendingPlayers` | open window |
| `get_reaction_window_skip_vote(round)` | `viewer.reaction.skipVote`, stall clock | open window |
| `get_my_courage_tokens(round)` | `viewer.reaction.courageTokens` | layer-0 window |
| `get_expected_layer_roller_ids(round, layer)` | `isExpectedToRoll`, `isPlayersTurnToRoll` | closed round |
| `get_layer_zero_window_closed_at(round)` | stall clock | closed layer 0 |
| `get_room_active_effects(room)` | `room.roster[].effectBadges` | polarity not null |
| `current_player_id(round, room)` | the viewer (granted in `0157`) | n/a |

Not bridged on purpose: Round Recap bodies. `get_round_recap` takes a row lock (`for share`), which a READ ONLY transaction rejects, and its provisional path dry-runs the resolver. The view carries only the **history entries** (round id, resolved at, cups, brewer). Recap bodies stay on the existing lazy `getRoundRecap` rpc until the resolver port (slice 7) gives the view a write-capable path. #539 must keep `RoundRecapHistory` / `RoundReveal` fetching recaps themselves.

## Mapping of today's page reads (src/app/page.tsx, admin/test-room/page.tsx)

| Page read | View field |
|---|---|
| `getCurrentPlayer`, Acting As (`getEffectiveTestRoomPlayerId`) | `viewer.playerId` |
| `getRoomRoster` (+ modifier) | `room.roster` |
| `getActiveRound`, `getRoundParticipants` | `room.activeRound` (+ `participants`) |
| `getRoundLayerParticipants`, `isTied` | `activeRound.tiedParticipants`, `viewer.isTied` |
| `getOwnRoll` (layers 0 / current) | `viewer.ownRoll`, `viewer.layerZeroOwnRoll` |
| `isExpectedLayerRoller`, `getRollInputMode` | `viewer.isPlayersTurnToRoll`, `needsRollInput`, `rollInputMode` |
| `roundHasAnyRolls` | `viewer.canDeclareLate` |
| `hasDeclared`, `isStarter`, `canClose` | `viewer.hasDeclared`, `isStarter`, `canClose`, `needMoreToClose`, `canDeclare`, `canWithdraw` |
| `getMyOrderableRound`, `getMyOrderForRound`, `getMyMostRecentOrder` | `viewer.orderRoundId`, `myOrderForRound`, `myMostRecentOrder`, `orderCue` |
| `getRoundMenu` (+ menu participants) | `viewer.menu`, `menuParticipants` |
| `getMyRateableRound` | `viewer.rateableRound` (own score only) |
| `getRoomPendingRoundReplay` | `viewer.pendingRoundReplay` |
| `getRoomRounds` | `room.history` (empty for the Test Room, like `stats_room_rounds`) |
| `getSpellCardCatalog` (draw choice) | `viewer.pendingSpellDraw.catalogNames` |
| every other bridge above | see the table above |
| which panels render | `viewer.panels` |
| `enforceStallTimeout` clocks | `room.nextStallDeadline` (pure `StallDeadline.Next`) |

## Not in the view (chrome stays a server-component prop)

Profile / sign-out name, admin flags and admin mode, roll input mode picker settings, the Test Room switcher options.

## Known gaps handed off

* **StallCheck**: the GET does not enforce stalls (slice 7). `nextStallDeadline` is the earliest clock strictly in the future; an already-overdue clock is not offered (the interim `enforceStall(roomId)` server action covers it on mount, resync and the deadline timer).
* **`autoDeclineStalledRoundReplays`** is a write and is not run by the view. `pendingRoundReplay` is shown until the interim sweep clears it.
* **Rolls of a scrapped Replay generation** are filtered by `rounds.replay_generation`.
* Bridges that call `current_player_id()` with no room (`get_my_pending_spell_draw`, `player_settings`) resolve the real caller, exactly as today's test-room page does.
