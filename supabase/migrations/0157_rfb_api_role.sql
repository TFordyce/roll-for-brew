-- rfb_api: the C# API's database login (spec #533, ADR 0013 as amended; slice 0b, #535).
--
-- The API connects through the Supavisor transaction pooler as rfb_api.<project-ref>. It is the
-- sole authorizer, so it bypasses RLS; RLS stays enabled with no policies for everyone else.
--
-- Deliberately NOT granted (postgres cannot grant them on hosted, verified on #532):
--   * usage on schema auth or realtime
--   * membership of authenticated
-- The API reads `sub` from the validated JWT and reaches auth.* only through security definer
-- functions (current_player_id). It sets request.jwt.claims per transaction; it never does
-- `set local role`.
--
-- No password here. On hosted it is set by hand and kept in GCP Secret Manager
-- (docs/port/rfb-api-role-runbook.md). No DDL, no writes to auth.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rfb_api') then
    create role rfb_api login bypassrls nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end
$$;

alter role rfb_api bypassrls;
alter role rfb_api set statement_timeout = '15s';

grant usage on schema public to rfb_api;

-- DML on public, today and for objects postgres creates later.
grant select, insert, update, delete on all tables in schema public to rfb_api;
grant usage, select on all sequences in schema public to rfb_api;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to rfb_api;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to rfb_api;

-- The repo revokes PUBLIC execute on functions, so DML alone is not enough. Grant execute on
-- each still-bridged SQL function; revoke it as each function is ported away (spec #533).
-- current_player_id(uuid, uuid) is the Acting As resolver (ADR 0001, ADR 0009).
grant execute on function public.current_player_id(uuid, uuid) to rfb_api;
