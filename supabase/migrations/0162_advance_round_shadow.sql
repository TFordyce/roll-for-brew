-- Evaluator shadow (spec #533, slice 2a-5, issue #546): the C# API runs `Evaluate`
-- beside SQL and calls `advance_layer` / `finalize_layer` as bridges, inside its own
-- transaction, with SQL staying authoritative. Additive: a disabled seed row for the
-- slice flag and the EXECUTE grants the bridges need. Nothing else changes -- the
-- rules freeze holds and Trace/Summary jsonb stay byte-for-byte.
--
-- The TS wrapper (`src/lib/supabase/roundAdvancement.ts`) reads the flag through
-- `isPortEnabled(supabase, 'advanceRound', roomId)`: a room row overrides the global
-- row, so rollout is Test Room first, then the global flip (outside play hours; the
-- flips themselves are human steps -- see docs/port/advance-round-bridges.md).
-- Rollback is `update public.port_flags set enabled = false ...` or deleting the row.
insert into public.port_flags (slice, enabled)
values ('advanceRound', false)
on conflict (slice, room_id) do nothing;

-- The repo revokes PUBLIC execute on functions, so rfb_api's DML alone is not
-- enough (0157). Grant EXECUTE on exactly the two bridged entry points; their
-- `security definer` internals (`resolve_round`, the `_rr_*` subtree) run as the
-- function owner and need no grant of their own. Revoke these as slice 2b ports
-- the resolver and the functions die. Listed on issue #546 and in
-- docs/port/advance-round-bridges.md.
grant execute on function public.advance_layer(uuid) to rfb_api;
grant execute on function public.finalize_layer(uuid) to rfb_api;
