-- Issue #409 (spec #402, ADR 0007): delete the second explanation path.
--
-- get_round_modifier_effects was a partial preview of a round's casts (no
-- wards, redirects, backfire, persistent transfers or lowest-gains-highest)
-- that fed RoundReveal's TypeScript badge recomposition. The roll row now
-- renders the resolver's own output -- the Resolution Summary, or the
-- Provisional Recap's dry run while the round is live -- so nothing in the app
-- reads it any more.
drop function if exists public.get_round_modifier_effects(uuid);

-- The integration suite's replacement observation seam
-- (tests/integration/setup.ts roundModifierEffects) reads the live
-- carried-forward effects with the service role. service_role already
-- bypasses RLS; this only lets it call the helper directly.
grant execute on function public._rr_active_effects_as_of(uuid, uuid) to service_role;
grant execute on function public._rr_effect_rounds_elapsed(uuid, timestamptz, timestamptz) to service_role;
