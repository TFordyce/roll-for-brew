# SQL function call graph (generated 2026-10-07)

Input to the C# port planning. Built by a regex scan of `db/sql/functions/*.sql` plus the latest
`create function` body per name in `supabase/migrations`. **Approximate**: dynamic SQL is missed, and
"writes" are a naive `insert into|update|delete from` scan (noise tokens removed). `*` = canonical in `db/sql/functions`
(the rest live only in migrations). LOC includes trailing grants/comments. Level 0 = no calls to other
project functions; level N = 1 + max level of callees (port bottom-up).

Totals: 180 functions, 15134 lines.

## Level 0 (46)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `_rr_build_copy_inputs` | 116 |  |  | 2 |
| `_rr_record_backfire` | 95 |  | spell_casts | 1 |
| `current_player_id` | 78 |  |  | 65 |
| `record_pending_round_replay` | 65 |  | pending_round_replay | 1 |
| `_rr_pick_lowest`* | 58 |  |  | 2 |
| `resolve_stalled_pending_spell_dice` | 53 |  | spell_casts | 0 |
| `apply_lowest_gains_highest_modifier` | 48 |  | rolls | 0 |
| `_rr_incoming_polarity` | 47 |  |  | 1 |
| `get_held_card_effect` | 46 |  |  | 2 |
| `_rr_compose_modifier` | 44 |  |  | 1 |
| `_rr_participated_rounds_elapsed`* | 40 |  |  | 2 |
| `enter_todays_room` | 39 |  | rooms, room_players | 0 |
| `get_reaction_stack`* | 38 |  |  | 0 |
| `_layer_rolls_json`* | 37 |  |  | 2 |
| `_rr_free_hand_slot`* | 37 |  |  | 4 |
| `get_current_layer_roller_ids` | 36 |  |  | 0 |
| `_rr_is_brewer_candidate`* | 36 |  |  | 1 |
| `check_whitelist_before_user_created` | 35 |  |  | 0 |
| `player_has_eligible_spell_cast` | 34 |  |  | 2 |
| `get_layer_zero_window_closed_at`* | 34 |  |  | 0 |
| `_rr_ward_wards_ward` | 33 |  |  | 1 |
| `round_layer_zero_reaction_window_exists` | 32 |  |  | 0 |
| `_rr_spell_modifier_delta` | 32 |  |  | 3 |
| `upsert_player_from_auth_user` | 30 |  | players | 0 |
| `enforce_whitelist_on_access_token` | 29 |  |  | 0 |
| `has_active_cast_kind` | 29 |  |  | 1 |
| `_revolt_outstanding_casts` | 29 |  |  | 3 |
| `swap_room_player_modifiers` | 28 |  | room_players | 1 |
| `_rr_base_modifier` | 28 |  |  | 2 |
| `resolve_stalled_pending_forced_reroll_casts` | 28 |  | spell_casts | 0 |
| `get_forced_reroll_targets` | 27 |  |  | 1 |
| `attach_pre_roll_forced_reroll_casts` | 27 |  | spell_casts | 2 |
| `_rr_trace_step`* | 26 |  |  | 6 |
| `attach_pre_roll_roll_pair_transform_casts` | 26 |  | spell_casts | 1 |
| `_rr_ward_blocks_row` | 25 |  |  | 2 |
| `_rr_ward_block_marker` | 25 |  |  | 1 |
| `get_todays_modifiers` | 23 |  |  | 0 |
| `cancel_round` | 22 |  | rounds | 0 |
| `_rr_mark_replay_cast_scrapped` | 21 |  | spell_casts | 3 |
| `get_room_pending_round_replay` | 21 |  |  | 0 |
| `_rr_effect_rounds_elapsed` | 20 |  |  | 2 |
| `_reaction_skip_threshold` | 18 |  |  | 2 |
| `holds_usable_reaction_card` | 17 |  |  | 1 |
| `has_passed_reaction_poll` | 16 |  |  | 2 |
| `_rr_tier_default_dc` | 16 |  |  | 3 |
| `close_reaction_window` | 14 |  | spell_reaction_windows | 5 |

## Level 1 (44)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `_rr_invocation_resolution` | 194 | `_rr_tier_default_dc`, `_rr_build_copy_inputs` |  | 1 |
| `_rr_active_effects_as_of`* | 187 | `_rr_effect_rounds_elapsed`, `_rr_participated_rounds_elapsed` |  | 16 |
| `_rr_cast_log_resolution`* | 153 | `_rr_tier_default_dc` |  | 3 |
| `record_active_effect_if_persistent`* | 102 | `_rr_ward_wards_ward` | spell_active_effects | 4 |
| `_rr_heist_outcomes`* | 102 | `_rr_free_hand_slot` |  | 2 |
| `submit_brew_rating` | 92 | `current_player_id` | brew_ratings | 0 |
| `_rr_draw_redirect_trace`* | 88 | `_rr_trace_step` |  | 1 |
| `submit_order` | 82 | `current_player_id` | orders | 0 |
| `admin_allocate_spell_card` | 80 | `current_player_id` | spell_deck_instances, spell_draws | 0 |
| `log_modifier_adjustment` | 69 | `current_player_id` | modifier_adjustments, room_players | 0 |
| `get_layer0_rolls_if_complete` | 55 | `current_player_id` |  | 0 |
| `delete_modifier_adjustment` | 54 | `current_player_id` | room_players, modifier_adjustments | 0 |
| `declare_in_late` | 54 | `current_player_id` | round_participants | 0 |
| `admin_get_card_assignments` | 53 | `current_player_id` |  | 0 |
| `admin_delete_modifier_adjustment` | 52 | `current_player_id` | admin_modifier_adjustment_deletions, room_players, modifier_adjustments | 0 |
| `rate_spell_card` | 52 | `current_player_id`, `player_has_eligible_spell_cast` | spell_card_ratings | 0 |
| `get_heist_targets` | 52 | `current_player_id` | spell_deck_instances | 0 |
| `decline_round_replay` | 51 | `current_player_id`, `_rr_mark_replay_cast_scrapped` | pending_round_replay | 0 |
| `resolve_pending_spell_die_in_app` | 49 | `current_player_id` | spell_casts | 0 |
| `get_player_spell_collection` | 48 | `current_player_id`, `player_has_eligible_spell_cast` |  | 1 |
| `admin_unassign_spell_card` | 45 | `current_player_id` | spell_deck_instances | 0 |
| `resolve_pending_spell_die_manual` | 45 | `current_player_id` | spell_casts | 0 |
| `_rr_override_step`* | 44 | `_rr_trace_step` |  | 1 |
| `declare_in` | 43 | `current_player_id` | round_participants | 0 |
| `get_tea_maker_override` | 43 | `current_player_id` |  | 0 |
| `_rr_brewer_immunity_step`* | 42 | `_rr_trace_step` |  | 1 |
| `withdraw_brew_rating` | 40 | `current_player_id` | brew_ratings | 0 |
| `withdraw_declaration` | 38 | `current_player_id` | round_participants | 0 |
| `auto_decline_stalled_round_replays` | 38 | `_rr_mark_replay_cast_scrapped` | pending_round_replay | 1 |
| `get_modifier_breakdown` | 37 | `current_player_id`, `_rr_spell_modifier_delta` |  | 1 |
| `set_acting_as` | 36 | `current_player_id` | admin_acting_as | 0 |
| `_rr_recompute_modifier_cache` | 36 | `_rr_base_modifier`, `_rr_spell_modifier_delta` | room_players | 2 |
| `resolve_stalled_revolt_picks` | 36 | `_revolt_outstanding_casts` | spell_casts | 0 |
| `get_acting_as` | 33 | `current_player_id` |  | 0 |
| `get_in_deck_spell_cards` | 33 | `current_player_id` |  | 1 |
| `round_has_any_rolls` | 31 | `current_player_id` |  | 0 |
| `get_my_pending_spell_dice` | 31 | `current_player_id` |  | 0 |
| `_rr_ward_hit` | 31 | `_rr_ward_blocks_row` |  | 1 |
| `end_test_session` | 30 | `current_player_id` | spell_active_effects, rounds, room_players, admin_acting_as | 0 |
| `get_my_pending_spell_draw` | 29 | `current_player_id` |  | 0 |
| `_rr_el_polarity` | 27 | `_rr_incoming_polarity` |  | 1 |
| `_revolt_pick_outstanding` | 27 | `_revolt_outstanding_casts` |  | 4 |
| `get_my_pending_casts` | 26 | `current_player_id` |  | 0 |
| `get_pending_spell_draw` | 22 | `current_player_id` |  | 0 |

## Level 2 (24)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `_rr_scrap_round`* | 262 | `_rr_active_effects_as_of`, `_rr_recompute_modifier_cache`, `_rr_mark_replay_cast_scrapped`, `_rr_free_hand_slot` | rounds, spell_deck_instances, spell_active_effects, spell_casts, rolls, round_layer_participants, spell_reaction_windows, brew_ratings | 1 |
| `_land_drawn_instance`* | 161 | `_rr_active_effects_as_of`, `_rr_free_hand_slot` | spell_deck_instances, spell_draws, spell_casts | 4 |
| `_apply_crit_redirect`* | 142 | `_rr_active_effects_as_of` | spell_casts | 3 |
| `_compelled_card_has_legal_target`* | 116 | `_rr_active_effects_as_of` |  | 2 |
| `set_spell_cast_target` | 95 | `current_player_id`, `record_active_effect_if_persistent`, `attach_pre_roll_forced_reroll_casts` | spell_casts, spell_deck_instances | 0 |
| `admin_delete_round` | 94 | `current_player_id`, `swap_room_player_modifiers`, `_rr_recompute_modifier_cache` | admin_round_deletions, rounds | 0 |
| `_brew_debt_due`* | 94 | `_rr_active_effects_as_of` |  | 5 |
| `get_room_active_effects`* | 92 | `current_player_id`, `_rr_effect_rounds_elapsed`, `_rr_active_effects_as_of`, `_rr_participated_rounds_elapsed` |  | 0 |
| `_rr_apply_earl_title`* | 85 | `_rr_active_effects_as_of` | spell_active_effects | 1 |
| `rebuild_active_effects_projection` | 83 | `record_active_effect_if_persistent` | spell_active_effects | 0 |
| `_fan_out_table_placeholder_casts`* | 80 | `record_active_effect_if_persistent` | spell_casts | 2 |
| `_rr_roll_exemptions`* | 76 | `_rr_cast_log_resolution` |  | 3 |
| `get_round_modifier_effects` | 74 | `current_player_id`, `_rr_active_effects_as_of` |  | 0 |
| `start_round`* | 66 | `current_player_id`, `auto_decline_stalled_round_replays` | rounds, round_participants | 0 |
| `get_dispellable_active_effects`* | 66 | `current_player_id`, `get_held_card_effect`, `_rr_active_effects_as_of` |  | 0 |
| `_rr_emit_modifier_swap_pair` | 59 | `get_modifier_breakdown` | spell_casts | 1 |
| `_rr_apply_heists`* | 59 | `_rr_free_hand_slot`, `_rr_heist_outcomes` | spell_deck_instances, spell_casts | 1 |
| `_rr_heist_trace`* | 49 | `_rr_trace_step`, `_rr_heist_outcomes` |  | 1 |
| `resolve_declared_number_tea_maker` | 48 | `_rr_active_effects_as_of` |  | 0 |
| `get_my_spell_cards` | 44 | `current_player_id`, `get_in_deck_spell_cards` |  | 0 |
| `_rr_active_ward_gate`* | 43 | `_rr_ward_blocks_row`, `_rr_active_effects_as_of` |  | 8 |
| `withdraw_spell_card_rating` | 39 | `current_player_id`, `get_player_spell_collection` | spell_card_ratings | 0 |
| `_unspent_courage_tokens`* | 36 | `_rr_active_effects_as_of` |  | 3 |
| `_rr_brewmageddon_negated`* | 29 | `_rr_cast_log_resolution` |  | 1 |

## Level 3 (16)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `_rr_select_tea_maker`* | 774 | `_rr_trace_step`, `_rr_pick_lowest`, `_rr_active_effects_as_of`, `_rr_brewer_immunity_step`, `_rr_is_brewer_candidate`, `_rr_override_step`, `_brew_debt_due` |  | 1 |
| `apply_roll_pair_transform` | 165 | `_rr_active_ward_gate` | spell_casts, rolls | 1 |
| `apply_roll_swap` | 140 | `_rr_active_ward_gate` | rolls, spell_casts | 1 |
| `apply_forced_reroll` | 105 | `_rr_active_ward_gate` | spell_casts, rolls | 1 |
| `_rr_apply_fixed_roll`* | 105 | `_rr_active_ward_gate` | spell_casts | 2 |
| `draw_spell_card_as`* | 102 | `current_player_id`, `_apply_crit_redirect`, `_land_drawn_instance` |  | 0 |
| `apply_roll_flip` | 91 | `_rr_active_ward_gate` | rolls, spell_casts | 1 |
| `draw_pending_spell_card_manual`* | 63 | `current_player_id`, `_land_drawn_instance` | pending_spell_draws | 0 |
| `draw_pending_spell_card`* | 60 | `current_player_id`, `_land_drawn_instance` | pending_spell_draws | 0 |
| `get_expected_layer_roller_ids`* | 56 | `_brew_debt_due`, `_rr_roll_exemptions` |  | 2 |
| `draw_spell_card`* | 53 | `current_player_id`, `_land_drawn_instance` |  | 0 |
| `_is_reaction_source`* | 52 | `holds_usable_reaction_card`, `_unspent_courage_tokens` |  | 4 |
| `record_pending_spell_draw`* | 45 | `current_player_id`, `_apply_crit_redirect` | pending_spell_draws | 0 |
| `confirm_round_replay` | 41 | `current_player_id`, `_rr_scrap_round` | pending_round_replay | 0 |
| `_compelled_outstanding`* | 39 | `_rr_brewmageddon_negated` |  | 10 |
| `get_my_courage_tokens`* | 33 | `current_player_id`, `_unspent_courage_tokens` |  | 0 |

## Level 4 (10)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `_forfeit_compelled_card`* | 51 | `_compelled_outstanding` | spell_deck_instances, spell_casts | 5 |
| `_rr_finish_compelled_cast`* | 41 | `_compelled_outstanding`, `_fan_out_table_placeholder_casts` | spell_casts | 3 |
| `get_open_reaction_window`* | 37 | `current_player_id`, `has_passed_reaction_poll`, `_is_reaction_source` |  | 0 |
| `_reaction_window_waiting_on`* | 31 | `has_passed_reaction_poll`, `_is_reaction_source` |  | 4 |
| `get_compelled_cast_step`* | 30 | `_compelled_outstanding` |  | 0 |
| `get_my_compelled_cast`* | 30 | `current_player_id`, `_compelled_outstanding` |  | 0 |
| `count_eligible_reaction_holders`* | 28 | `_is_reaction_source` |  | 4 |
| `_compelled_cast_step_open`* | 25 | `_compelled_outstanding` |  | 3 |
| `_owes_compelled_action_cast`* | 20 | `_compelled_outstanding` |  | 2 |
| `count_expected_layer_rollers` | 14 | `get_expected_layer_roller_ids` |  | 8 |

## Level 5 (20)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `_rr_resolve_eval`* | 2139 | `count_expected_layer_rollers`, `_rr_compose_modifier`, `_rr_trace_step`, `_rr_pick_lowest`, `_rr_cast_log_resolution`, `_rr_el_polarity`, `_rr_ward_hit`, `_rr_active_effects_as_of`, `_rr_base_modifier`, `_rr_spell_modifier_delta`, `_rr_invocation_resolution`, `_rr_heist_trace`, `_rr_select_tea_maker`, `_rr_roll_exemptions`, `_rr_draw_redirect_trace` | spell_casts, room_players | 2 |
| `cast_spell_card`* | 909 | `current_player_id`, `record_active_effect_if_persistent`, `_rr_active_ward_gate`, `_rr_emit_modifier_swap_pair`, `_rr_ward_block_marker`, `_owes_compelled_action_cast`, `_rr_finish_compelled_cast` | spell_deck_instances, spell_casts, room_players, spell_active_effects | 0 |
| `admin_proxy_roll`* | 111 | `current_player_id`, `_compelled_cast_step_open`, `_apply_crit_redirect` | room_players, round_participants, rolls, pending_spell_draws | 0 |
| `end_active_effect`* | 97 | `current_player_id`, `get_held_card_effect`, `_owes_compelled_action_cast`, `_rr_finish_compelled_cast` | spell_deck_instances, spell_casts | 0 |
| `_layer_is_complete`* | 87 | `count_expected_layer_rollers`, `_compelled_cast_step_open`, `_revolt_pick_outstanding` |  | 2 |
| `get_completed_layer_rolls_for_stall_resolution` | 79 | `count_expected_layer_rollers` |  | 0 |
| `resolve_card_swap` | 67 | `current_player_id`, `count_eligible_reaction_holders`, `close_reaction_window` | spell_deck_instances | 0 |
| `pass_reaction_window`* | 63 | `current_player_id`, `count_eligible_reaction_holders`, `close_reaction_window`, `_compelled_outstanding`, `_is_reaction_source` | spell_reaction_passes | 0 |
| `get_round_layer_history` | 63 | `count_expected_layer_rollers` |  | 0 |
| `get_reaction_window_skip_vote` | 57 | `current_player_id`, `_reaction_window_waiting_on`, `_reaction_skip_threshold` |  | 0 |
| `open_reaction_window` | 48 | `count_eligible_reaction_holders`, `close_reaction_window`, `attach_pre_roll_forced_reroll_casts`, `attach_pre_roll_roll_pair_transform_casts` | spell_reaction_windows | 1 |
| `_fix_compelled_set`* | 47 | `_compelled_card_has_legal_target`, `_compelled_outstanding`, `_forfeit_compelled_card` | spell_casts | 1 |
| `_auto_pass_reaction_window`* | 42 | `close_reaction_window`, `_reaction_window_waiting_on`, `_forfeit_compelled_card` | spell_reaction_passes | 2 |
| `_revolt_picker` | 39 | `count_expected_layer_rollers` |  | 3 |
| `get_reaction_window_pending_players` | 37 | `_reaction_window_waiting_on` |  | 0 |
| `forfeit_stalled_compelled_casts`* | 36 | `_compelled_outstanding`, `_forfeit_compelled_card` |  | 0 |
| `exclude_round_participant`* | 31 | `_forfeit_compelled_card` | round_participants, round_layer_participants | 0 |
| `is_expected_layer_roller`* | 28 | `get_expected_layer_roller_ids`, `_compelled_cast_step_open` |  | 6 |
| `_forfeit_untargetable_compelled_reactions`* | 27 | `_compelled_card_has_legal_target`, `_compelled_outstanding`, `_forfeit_compelled_card` |  | 1 |
| `_rr_reopen_or_close_reaction_poll` | 24 | `count_eligible_reaction_holders`, `close_reaction_window` | spell_reaction_windows | 2 |

## Level 6 (15)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `cast_reaction_spell_card`* | 400 | `current_player_id`, `_rr_tier_default_dc`, `_rr_record_backfire`, `_rr_build_copy_inputs`, `_rr_reopen_or_close_reaction_poll`, `_rr_finish_compelled_cast` | spell_deck_instances, spell_casts | 0 |
| `submit_roll`* | 292 | `current_player_id`, `is_expected_layer_roller`, `_rr_active_ward_gate`, `_rr_active_effects_as_of`, `_rr_apply_fixed_roll` | rolls, spell_casts | 0 |
| `submit_roll_as`* | 283 | `current_player_id`, `is_expected_layer_roller`, `_rr_active_ward_gate`, `_rr_active_effects_as_of`, `_rr_apply_fixed_roll` | rolls, spell_casts | 0 |
| `spend_courage_token`* | 111 | `current_player_id`, `_rr_reopen_or_close_reaction_poll`, `_unspent_courage_tokens` | spell_casts | 0 |
| `get_current_layer_rolls_if_complete` | 83 | `current_player_id`, `is_expected_layer_roller`, `count_expected_layer_rollers` |  | 0 |
| `set_tea_party_revolt_target` | 79 | `current_player_id`, `_revolt_outstanding_casts`, `_revolt_pick_outstanding`, `_revolt_picker` | spell_casts | 0 |
| `advance_round_layer`* | 75 | `is_expected_layer_roller`, `_rr_roll_exemptions` | round_layer_participants, rounds | 2 |
| `close_round`* | 72 | `current_player_id`, `_fan_out_table_placeholder_casts`, `_fix_compelled_set`, `_brew_debt_due` | rounds | 0 |
| `vote_skip_reaction_window` | 71 | `current_player_id`, `_reaction_window_waiting_on`, `_reaction_skip_threshold`, `_auto_pass_reaction_window` | spell_reaction_skip_votes | 0 |
| `submit_manual_roll_as` | 60 | `current_player_id`, `is_expected_layer_roller` | rolls | 0 |
| `_rr_resolve`* | 52 | `resolve_round`, `_rr_resolve_eval` |  | 2 |
| `submit_manual_roll` | 51 | `current_player_id`, `is_expected_layer_roller` | rolls | 0 |
| `get_tea_party_revolt_picker` | 34 | `_revolt_pick_outstanding`, `_revolt_picker` |  | 0 |
| `time_out_reaction_window` | 31 | `_auto_pass_reaction_window` |  | 0 |
| `_layer_hold_reason` | 27 | `_revolt_pick_outstanding`, `_revolt_picker` |  | 2 |

## Level 7 (2)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `get_round_recap`* | 243 | `current_player_id`, `count_expected_layer_rollers`, `_rr_resolve` |  | 0 |
| `resolve_round`* | 177 | `count_expected_layer_rollers`, `_rr_resolve`, `_rr_resolve_eval` | rounds, room_players | 3 |

## Level 8 (2)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `admin_backfill_round` | 241 | `current_player_id`, `resolve_round`, `advance_round_layer` | rooms, room_players, rounds, round_participants, rolls | 0 |
| `finalize_layer`* | 201 | `resolve_round`, `advance_round_layer`, `get_forced_reroll_targets`, `apply_forced_reroll`, `apply_roll_swap`, `apply_roll_flip`, `has_active_cast_kind`, `record_pending_round_replay`, `apply_roll_pair_transform`, `_layer_is_complete`, `_layer_rolls_json`, `_rr_apply_heists`, `_layer_hold_reason`, `_rr_apply_earl_title`, `_brew_debt_due` | rounds | 1 |

## Level 9 (1)

| function | LOC | calls | writes | called by |
|---|---|---|---|---|
| `advance_layer`* | 127 | `open_reaction_window`, `_layer_is_complete`, `finalize_layer`, `_layer_rolls_json`, `_forfeit_untargetable_compelled_reactions`, `_layer_hold_reason`, `_brew_debt_due` |  | 0 |

