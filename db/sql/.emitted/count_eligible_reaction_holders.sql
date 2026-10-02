-- count_eligible_reaction_holders(uuid) -> integer
--
-- How many of the round's participants have a Reaction Source. Issue #439:
-- reads _is_reaction_source (a held Reaction card, or a live unspent Courage
-- Token at Layer 0) instead of held Reaction cards alone. Otherwise unchanged
-- (0064): open_reaction_window, _rr_reopen_or_close_reaction_poll,
-- resolve_card_swap and the stall recovery close a window when this is 0.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.count_eligible_reaction_holders(p_round_id uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.round_participants rp
   where rp.round_id = p_round_id
     and public._is_reaction_source(p_round_id, rp.player_id);
$$;

revoke execute on function public.count_eligible_reaction_holders(uuid) from public, anon;
grant execute on function public.count_eligible_reaction_holders(uuid) to authenticated;
