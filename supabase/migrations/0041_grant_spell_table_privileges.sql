-- Fixes issue #137: migration 0015's table-level grants were a one-time
-- snapshot of the tables that existed at that point (players, rooms,
-- room_players, rounds, round_participants, rolls,
-- round_layer_participants, player_settings) — `grant ... on all tables in
-- schema public` does not apply to tables created by *later* migrations.
-- Every spell-system table added since 0017 was left with no table-level
-- grant at all, so on a fresh project (no legacy auto_expose_new_tables
-- behaviour — including local `supabase start`/`db reset`) PostgREST can't
-- reach them for either `authenticated` or `service_role`, surfacing as
-- "permission denied for table ..." (confirmed by a clean local Docker
-- integration run: 29/29 failures were exactly this). Migration 0040
-- already fixed this one-off for spell_draws/authenticated; this
-- generalizes the same fix to every other ungranted spell table.
--
-- service_role gets `all` on every affected table, matching 0015's
-- `grant all ... to service_role` — RLS is bypassed for service_role, but
-- the Data API role still needs the table-level grant to touch it at all,
-- and admin/test-setup code (createTestAdminClient) reads and writes these
-- tables directly.
grant all on public.spell_cards to service_role;
grant all on public.spell_deck_instances to service_role;
grant all on public.spell_draws to service_role;
grant all on public.spell_casts to service_role;
grant all on public.spell_active_effects to service_role;
grant all on public.spell_reaction_windows to service_role;
grant all on public.spell_reaction_passes to service_role;
grant all on public.admin_acting_as to service_role;
grant all on public.spell_card_effects to service_role;
grant all on public.pending_spell_draws to service_role;

-- authenticated gets `select` only where an RLS select policy already
-- exists to gate which rows come back; all writes to these tables go
-- through security-definer RPCs, and spell_casts / spell_active_effects /
-- spell_reaction_windows / spell_reaction_passes / admin_acting_as have no
-- select policy for authenticated at all (read only via narrowly-scoped
-- RPCs, per their own migration comments), so they're deliberately left
-- out here — granting select on them would be inert (RLS default-denies
-- every row) but would misstate the access model.
grant select on public.spell_cards to authenticated;
grant select on public.spell_deck_instances to authenticated;
grant select on public.spell_card_effects to authenticated;
grant select on public.pending_spell_draws to authenticated;
-- spell_draws/authenticated select was already granted by 0040.
