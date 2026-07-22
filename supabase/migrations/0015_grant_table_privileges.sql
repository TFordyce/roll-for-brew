-- Every table so far relies on RLS policies to gate `authenticated` access,
-- and on service_role's RLS-bypass to gate admin/test access — but a GRANT
-- is a separate, more basic check Postgres applies before RLS even runs.
-- These migrations never issued one. The hosted project has worked anyway
-- because it was created back when Supabase auto-granted Data API roles
-- (anon/authenticated/service_role) full table access on every new table;
-- that auto-grant is being phased out (see the deprecated
-- api.auto_expose_new_tables setting) and a fresh local `supabase start`
-- never had it, which is what surfaced this — e.g. service_role got
-- "permission denied for table whitelist" even though RLS should have let
-- it straight through. Grant explicitly so behaviour no longer depends on
-- when/how the underlying Supabase project was created.

grant usage on schema public to service_role, authenticated;

-- service_role: trusted server-side/test-admin role, already bypasses RLS
-- by role attribute — give it the matching base table privileges.
grant all on all tables in schema public to service_role;

-- authenticated: base privileges matching each table's existing RLS
-- policies (supabase/migrations/0001, 0003, 0004, 0005, 0007, 0008).
-- RLS still does the real per-row gating; these just stop Postgres from
-- denying access before RLS gets a say.
grant select on public.players to authenticated;
grant select on public.rooms to authenticated;
grant select on public.room_players to authenticated;
grant select on public.rounds to authenticated;
grant select on public.round_participants to authenticated;
grant select on public.rolls to authenticated;
grant select on public.round_layer_participants to authenticated;
grant select, insert, update on public.player_settings to authenticated;
