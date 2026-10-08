# RFBnn → problem code mapping

Input to the C# port (map [#476](https://github.com/TFordyce/roll-for-brew/issues/476)). The error model comes from [Decide the API contract and TypeScript client](https://github.com/TFordyce/roll-for-brew/issues/485).

- **Response shape.** The API returns RFC 9457 `application/problem+json` with a stable `code` extension member (the name below). `title` is a fixed human sentence. `detail` may carry the `%`-filled specifics.
- **SQL-raised errors.** While a function is still SQL, `RoomStore` translates a SQL-raised `RFBnn` (`PostgresException.SqlState`) into the same problem. Raw SQLSTATE never leaks.
- **C#-raised errors.** Once ported, the C# rule throws a domain exception carrying the same `code`.
- **TS side.** Wrappers that test `error.code === 'RFBnn'` today switch to the problem `code` when their endpoint flips. Keep both checks while the flag can still roll back.
- **New codes.** Ported code may add new named codes. It never reuses or renumbers an `RFBnn`.

**HTTP status, by class:**

| Class | Status | Meaning |
|---|---|---|
| state | **409** | the round, window or replay moved on (stale-round race family) |
| rule | **422** | the request is well-formed but the rules forbid it |
| input | **400** | a bad value |
| auth | **403** | the caller lacks the right |
| missing | **404** | the thing isn't there |

Generated 2026-10-08 from `supabase/migrations` + `db/sql/functions` (scan: every `raise exception ... errcode = 'RFBnn'`).

| RFBnn | code | status | raised by | meaning |
|---|---|---|---|---|
| RFB01 | `round_not_open_for_rolling` | 409 | submit_roll, submit_manual_roll, submit_roll_as, submit_manual_roll_as | round is not closed for rolling |
| RFB02 | `not_expected_roller` | 409 | submit_roll (+ manual / _as variants), get_current_layer_rolls_if_complete | player is not expected to roll in the current layer |
| RFB03 | `round_not_open_for_casting` | 409 | cast_spell_card, set_spell_cast_target, end_active_effect, set_tea_party_revolt_target | round is not open for pre-roll casting / not awaiting a pick |
| RFB04 | `no_open_reaction_window` | 409 | cast_reaction_spell_card, pass_reaction_window, vote_skip_reaction_window, spend_courage_token | no open reaction window for this round |
| RFB05 | `round_not_open_for_declarations` | 409 | declare_in, withdraw_declaration | round is not open for declarations |
| RFB06 | `card_not_in_deck` | 409 | draw_pending_spell_card_manual | that card is not currently in the deck |
| RFB07 | `card_already_held` | 409 | admin_allocate_spell_card | that card is already held by someone |
| RFB08 | `player_already_holds_card` | 409 | admin_allocate_spell_card | that player already holds a card |
| RFB09 | `card_not_assigned` | 409 | admin_unassign_spell_card | that card is not assigned to anyone |
| RFB10 | `adjustment_delta_zero` | 400 | log_modifier_adjustment | delta must be non-zero |
| RFB11 | `adjustment_reason_required` | 400 | log_modifier_adjustment | reason is required |
| RFB12 | `adjustment_target_not_in_room` | 422 | log_modifier_adjustment | target is not in today's room |
| RFB13 | `adjustment_not_actor` | 403 | delete_modifier_adjustment | only the actor can undo their own adjustment |
| RFB14 | `adjustment_not_most_recent` | 422 | delete_modifier_adjustment | only the most recent adjustment can be undone |
| RFB15 | `adjustment_undo_window_passed` | 409 | delete_modifier_adjustment | the 5 minute undo window has passed |
| RFB16 | `admin_required_delete_round` | 403 | admin_delete_round | caller is not an admin |
| RFB17 | `delete_round_reason_required` | 400 | admin_delete_round | reason is required |
| RFB18 | `round_not_found` | 404 | admin_delete_round | round not found |
| RFB19 | `admin_required_delete_adjustment` | 403 | admin_delete_modifier_adjustment | caller is not an admin |
| RFB20 | `delete_adjustment_reason_required` | 400 | admin_delete_modifier_adjustment | reason is required |
| RFB21 | `adjustment_not_found` | 404 | admin_delete_modifier_adjustment | adjustment not found |
| RFB22 | `brew_rating_score_out_of_range` | 400 | submit_brew_rating | score must be between 1 and 5 |
| RFB23 | `brew_rating_round_not_rateable` | 404 | submit_brew_rating, withdraw_brew_rating | round not found or not resolved |
| RFB24 | `brew_rating_not_participant` | 403 | submit_brew_rating | caller did not participate in this round |
| RFB25 | `brew_rating_self` | 422 | submit_brew_rating | the brewer cannot rate themself |
| RFB26 | `brew_rating_not_most_recent` | 422 | submit_brew_rating | only the caller's most recent non-brewer round can be rated |
| RFB27 | `brew_rating_window_closed` | 409 | submit_brew_rating, withdraw_brew_rating | the rating window has closed |
| RFB28 | `order_drink_type_invalid` | 400 | submit_order | drink_type must be tea or coffee |
| RFB29 | `order_round_not_open` | 409 | submit_order | round not found or not open for ordering |
| RFB30 | `order_window_closed` | 409 | submit_order | the order window has closed |
| RFB31 | `round_closed_for_late_declare` | 409 | declare_in_late | round is no longer open for a late declare |
| RFB32 | `round_closed_for_proxy_roll` | 409 | admin_proxy_roll | round is no longer open for a proxy roll |
| RFB33 | `admin_required_backfill` | 403 | admin_backfill_round | caller is not an admin |
| RFB34 | `backfill_too_few_participants` | 400 | admin_backfill_round | at least 2 participants required |
| RFB35 | `backfill_no_layers` | 400 | admin_backfill_round | at least one layer of rolls is required |
| RFB36 | `backfill_round_in_progress` | 409 | admin_backfill_round | another round is already in progress in today's room |
| RFB37 | `backfill_layer_roster_mismatch` | 400 | admin_backfill_round | layer roster or a roll is missing |
| RFB38 | `backfill_roll_out_of_range` | 400 | admin_backfill_round | roll value must be between 1 and 20 |
| RFB39 | `backfill_extra_layer` | 400 | admin_backfill_round | round already resolved at a layer, no further layers expected |
| RFB40 | `backfill_layer_still_tied` | 400 | admin_backfill_round | layer is still tied, a further layer is required |
| RFB41 | `card_rating_score_out_of_range` | 400 | rate_spell_card | score must be between 1 and 5 |
| RFB42 | `card_not_found` | 404 | rate_spell_card | card not found |
| RFB43 | `card_rating_no_eligible_cast` | 403 | rate_spell_card | caller has no eligible cast of this card |
| RFB44 | `no_modifier_to_spend` | 422 | cast_reaction_spell_card | caster has no modifier to spend |
| RFB45 | `spend_amount_required` | 400 | cast_reaction_spell_card | Tea-tally Spent requires a spend amount |
| RFB46 | `invalid_cast_target` | 422 | cast_spell_card | card cannot target yourself / Tea Heist needs an explicit target |
| RFB47 | `replay_decision_state` | 409 | confirm_round_replay, start_round | no replay pending / a replay decision is still pending |
| RFB48 | `replay_not_caster` | 403 | confirm_round_replay, decline_round_replay | only the Time for Brew caster can keep or scrap the round |
| RFB49 | `invalid_invocation` | 422 | cast_reaction_spell_card | invocation cannot invoke an invocation / Brew-merang seizes only another player's cast |
| RFB50 | `cast_choice_required` | 422 | cast_spell_card | card not available in the deck / Genie must choose now |
| RFB51 | `skip_vote_too_early` | 409 | vote_skip_reaction_window | voting opens 30 seconds after the poll round started |
| RFB52 | `skip_vote_not_allowed` | 403 | vote_skip_reaction_window | only active participants can vote / the table is waiting on you |
| RFB53 | `heist_target_empty_hand` | 422 | cast_spell_card | that player is not holding a card to steal |
| RFB54 | `rolling_held_for_compelled_casts` | 409 | admin_proxy_roll | rolling is held until every compelled cast is in |
| RFB55 | `compelled_cast_required` | 422 | cast_spell_card, pass_reaction_window | a compelled cast must name its target now / Brewmageddon compels you to play |
| RFB56 | `no_courage_token_play` | 422 | spend_courage_token | no roll this round to add to / no Courage Token to spend |
| RFB57 | `stale_biscuit_choice_required` | 409 | admin_allocate_spell_card | the target has a live Stale Biscuit mark; choose where the card lands (detail = beneficiary id) |
| RFB58 | `stale_biscuit_mark_gone` | 409 | admin_allocate_spell_card | the Stale Biscuit mark is no longer live |
