-- Issue #552 (spec #533, slice 3, exit 4): delete the SQL the C# API replaced for the round lifecycle and roll
-- submission.
--
-- All 14 flags were on globally and soaked five play-days (16-20 Nov 2026, no rollback; Tom's confirmation is on
-- #552). The code that could still reach this SQL was removed first (#631), so no deployed build calls any of it.
--
-- * Round lifecycle (#550): start_round, declare_in, declare_in_late, withdraw_declaration, close_round,
--   cancel_round, exclude_round_participant, confirm_round_replay, decline_round_replay.
-- * Roll submission (#551): submit_roll, submit_manual_roll, submit_roll_as, submit_manual_roll_as,
--   admin_proxy_roll, and the helpers only they reached: _rr_apply_fixed_roll, is_expected_layer_roller and
--   _compelled_cast_step_open.
-- * The 14 port_flags rows that switched between the two paths.
--
-- The set is every function reachable only from those entry points: anything still called by a kept SQL function,
-- a TS .rpc, a C# bridge, a trigger or a policy stays. Each name is dropped with all its overloads.
--
-- The close-time bridges stay for the API (0166). service_role also gets them, so the integration suite can close
-- a round the way the API does now that close_round is gone (tests/integration/setup.ts closeRoundAs).
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
         'start_round', 'declare_in', 'declare_in_late', 'withdraw_declaration', 'close_round',
         'cancel_round', 'exclude_round_participant', 'confirm_round_replay', 'decline_round_replay',
         'submit_roll', 'submit_manual_roll', 'submit_roll_as', 'submit_manual_roll_as', 'admin_proxy_roll',
         '_rr_apply_fixed_roll', 'is_expected_layer_roller', '_compelled_cast_step_open'
       ])
  loop
    execute format('drop function %s', fn);
  end loop;
end
$$;

delete from public.port_flags
 where slice in ('startRound', 'declareIn', 'declareInLate', 'withdrawDeclaration', 'closeRound',
                 'cancelRound', 'excludeRoundParticipant', 'confirmRoundReplay', 'declineRoundReplay',
                 'submitRoll', 'submitManualRoll', 'submitRollAs', 'submitManualRollAs', 'adminProxyRoll');

grant execute on function public._fan_out_table_placeholder_casts(uuid, uuid) to service_role;
grant execute on function public._fix_compelled_set(uuid) to service_role;
