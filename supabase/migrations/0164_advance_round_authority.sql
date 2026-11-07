-- Authoritative AdvanceRound (spec #533, slice 2b-1, issue #547). Additive.
--
-- 1. public.rfb_broadcast: the in-transaction broadcast wrapper (ADR 0011). rfb_api has no
--    usage on the realtime schema, so it reaches realtime.send only through this function.
--    Plumbing, not rules logic: it stays in Postgres after the port.
-- 2. The 'advanceRoundAuthoritative' flag, seeded OFF. The existing 'advanceRound' row only
--    routes the wrappers to the API, where the shadow runs. This separate row is what makes
--    C# authoritative. Flips are human steps: docs/port/advance-round-bridges.md.
-- 3. EXECUTE on the two reaction-window bridges the authoritative path still calls. They are
--    slice 6's to port. The advance_layer/finalize_layer grants (0162) stay for the shadow.
--
-- rooms.version already exists (0160). No function bodies change: the SQL path is the
-- rollback and must keep reading what C# writes.

-- plpgsql, not sql: a sql body is checked at create time and realtime is not ours.
create function public.rfb_broadcast(p_topic text, p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(p_payload, p_event, p_topic, false);
end;
$$;

alter function public.rfb_broadcast(text, text, jsonb) owner to postgres;
revoke execute on function public.rfb_broadcast(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.rfb_broadcast(text, text, jsonb) to rfb_api;

comment on function public.rfb_broadcast(text, text, jsonb) is
  'Issue #547 (ADR 0011): the API''s in-transaction broadcast. Sends on a public room channel; delivered only on commit. realtime.send swallows failures as a WARNING, which the API treats as an error.';

insert into public.port_flags (slice, enabled)
values ('advanceRoundAuthoritative', false)
on conflict (slice, room_id) do nothing;

grant execute on function public.open_reaction_window(uuid, integer) to rfb_api;
grant execute on function public._forfeit_untargetable_compelled_reactions(uuid) to rfb_api;
