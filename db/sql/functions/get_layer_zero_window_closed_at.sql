-- get_layer_zero_window_closed_at(p_round_id uuid) -> timestamptz
--
-- Issue #433 (Roll Exemption): when the round's layer-0 Reaction Window
-- closed, or null while there is none or it is still open. Stall enforcement
-- restarts the Layer-0 roll clock here: a caster whose exemption was
-- countered only becomes an expected roller once the window closes, so their
-- late roll gets the full stall timeout from then, not from close_round.
--
-- spell_reaction_windows has no select policy (0021: window state is read
-- through narrow RPCs), hence this one. Any authenticated caller may read it
-- -- stall enforcement runs on every render, spectators included.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_layer_zero_window_closed_at(p_round_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select max(w.closed_at)
    from public.spell_reaction_windows w
   where w.round_id = p_round_id and w.layer = 0 and w.status = 'closed';
$$;

revoke execute on function public.get_layer_zero_window_closed_at(uuid) from public, anon;
grant execute on function public.get_layer_zero_window_closed_at(uuid) to authenticated;

comment on function public.get_layer_zero_window_closed_at(uuid) is
  'Issue #433: when the round''s layer-0 Reaction Window closed (null while none has). Stall enforcement restarts the Layer-0 roll clock there, so a caster whose Roll Exemption was countered gets the full timeout for their late roll.';
