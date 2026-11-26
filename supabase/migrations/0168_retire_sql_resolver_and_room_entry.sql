-- Issues #549 and #568 (spec #533, slice 2b and the room-entry Filler, exit 4): delete the SQL the C# API replaced.
--
-- Both soaked five play-days with their flags on globally (9-13 Nov 2026, no rollback; Tom's confirmation is on
-- each ticket), and the code that could still reach this SQL was removed first (#622, #623), so no deployed build
-- calls any of it.
--
-- * Round advancement, Round Recap and Round Backfill (#549): advance_layer, finalize_layer, every resolve_round
--   overload, _rr_resolve, _rr_resolve_eval, get_round_recap, admin_backfill_round, and the helpers that only they
--   reached: the Phase 5 tea-maker selection and its steps, the Trace and heist helpers, the modifier and polarity
--   helpers, _layer_is_complete, _layer_hold_reason, _layer_rolls_json, advance_round_layer, the roll shims and
--   record_pending_round_replay.
-- * Room entry and set Acting As (#568): enter_todays_room and set_acting_as.
-- * The six port_flags rows that switched between the two paths.
--
-- The set is every function reachable only from those entry points: anything still called by a kept SQL function,
-- a TS .rpc, a C# bridge, a trigger or a policy stays. Each name is dropped with all its overloads.
--
-- Hand-authored (ADR 0006: only function definitions are generated).

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = any (array[
         'advance_layer', 'finalize_layer', 'resolve_round', '_rr_resolve', '_rr_resolve_eval',
         'get_round_recap', 'admin_backfill_round',
         '_rr_select_tea_maker', '_rr_override_step', '_rr_brewer_immunity_step', '_rr_is_brewer_candidate',
         '_rr_pick_lowest', '_rr_apply_earl_title', '_rr_apply_heists', '_rr_heist_outcomes', '_rr_heist_trace',
         '_rr_draw_redirect_trace', '_rr_trace_step', '_rr_invocation_resolution', '_rr_compose_modifier',
         '_rr_el_polarity', '_rr_incoming_polarity', '_rr_ward_hit', 'has_active_cast_kind',
         '_layer_is_complete', '_layer_hold_reason', '_layer_rolls_json', 'advance_round_layer',
         'apply_forced_reroll', 'apply_roll_flip', 'apply_roll_pair_transform', 'apply_roll_swap',
         'get_forced_reroll_targets', 'record_pending_round_replay',
         'enter_todays_room', 'set_acting_as'
       ])
  loop
    execute format('drop function %s', fn);
  end loop;
end
$$;

delete from public.port_flags
 where slice in ('advanceRound', 'advanceRoundAuthoritative', 'getRoundRecap', 'adminBackfillRound',
                 'enterTodaysRoom', 'setActingAs');
