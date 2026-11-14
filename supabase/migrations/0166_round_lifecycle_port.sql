-- Round lifecycle commands on the C# API (spec #533, slice 3a, issue #550). Additive.
--
-- 1. Nine port flags, seeded OFF, one per TS wrapper. Each routes that wrapper to the API
--    (`isPortEnabled`); with no row or the row off, the wrapper keeps its SQL `.rpc`, which is the
--    rollback. Flips are human steps: docs/port/round-lifecycle-bridges.md.
-- 2. EXECUTE for rfb_api on the four internals the API still bridges to. Repo policy revokes
--    PUBLIC execute, so DML alone is not enough (0157). Revoke each as it is ported.
--    start_round, declare_in*, withdraw_declaration, close_round, cancel_round,
--    exclude_round_participant and the replay decision functions get NO grant: C# replaced them.
insert into public.port_flags (slice, enabled)
select s, false
  from unnest(array[
    'startRound', 'declareIn', 'declareInLate', 'withdrawDeclaration', 'closeRound',
    'cancelRound', 'excludeRoundParticipant', 'confirmRoundReplay', 'declineRoundReplay'
  ]) as s
on conflict (slice, room_id) do nothing;

grant execute on function public._fan_out_table_placeholder_casts(uuid, uuid) to rfb_api;
grant execute on function public._fix_compelled_set(uuid) to rfb_api;
grant execute on function public._forfeit_compelled_card(uuid, text, text) to rfb_api;
grant execute on function public._rr_scrap_round(uuid) to rfb_api;
