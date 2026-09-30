-- Issue #417 (spec #412, ADR 0008): drop the two Layer-completeness RPCs the
-- old TS advancement path read. Round advancement now decides completeness
-- inside advance_layer / finalize_layer via _layer_is_complete, which has no
-- caller-identity gate, so neither variant has a caller left:
--   * get_current_layer_rolls_if_complete -- the identity-gated read (latest
--     definition 0098);
--   * get_completed_layer_rolls_for_stall_resolution -- the stall-resolution
--     variant any authenticated user could call (latest definition 0098).
-- And the one commit RPC only the old TS path called:
--   * resolve_declared_number_tea_maker -- the Inscribed Saucer lookup
--     (latest definition 0084). Since #310 the declared-number sentinel is a
--     duration-1 projection row, so finalize_layer's resolution commit is
--     what burns it; resolve_round names the brewer itself.
--
-- Hand-authored (ADR 0006: only function definitions are generated).
--
-- Deliberately kept: the eager-shim and commit RPCs finalize_layer calls
-- internally (get_forced_reroll_targets, has_active_cast_kind,
-- apply_forced_reroll, apply_roll_flip, apply_roll_swap,
-- apply_roll_pair_transform, the 4-arg resolve_round, advance_round_layer,
-- record_pending_round_replay), and open_reaction_window, which advance_layer
-- calls. get_tea_maker_override is a read, not part of the old advancement
-- path, and stays.

drop function if exists public.get_current_layer_rolls_if_complete(uuid);
drop function if exists public.get_completed_layer_rolls_for_stall_resolution(uuid);
drop function if exists public.resolve_declared_number_tea_maker(uuid, integer);
