-- Roll submission on the C# API (spec #533, slice 3b, issue #551). Additive.
--
-- 1. Five port flags, seeded OFF, one per TS wrapper. Each routes that wrapper to the API
--    (`isPortEnabled`); with no row or the row off, the wrapper keeps its SQL `.rpc`, which is the
--    rollback. Flips are human steps: docs/port/roll-submission-bridges.md.
-- 2. EXECUTE for rfb_api on the one internal the API still bridges to (_apply_crit_redirect), plus the
--    two it calls as invoker (_rr_active_effects_as_of, _rr_participated_rounds_elapsed; without them
--    a Proxy Roll nat 1 / nat 20 fails with 42501). Repo policy revokes PUBLIC execute, so DML alone
--    is not enough (0157). Revoke all three when the crit redirect is ported.
--    submit_roll, submit_manual_roll, their _as twins and admin_proxy_roll get NO grant: C# replaced them.
insert into public.port_flags (slice, enabled)
select s, false
  from unnest(array[
    'submitRoll', 'submitManualRoll', 'submitRollAs', 'submitManualRollAs', 'adminProxyRoll'
  ]) as s
on conflict (slice, room_id) do nothing;

grant execute on function public._apply_crit_redirect(uuid, text) to rfb_api;
grant execute on function public._rr_active_effects_as_of(uuid, uuid) to rfb_api;
grant execute on function public._rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) to rfb_api;
