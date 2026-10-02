-- _reaction_window_waiting_on(uuid, uuid, integer) -> setof text
--
-- The players being waited on: round participants with a Reaction Source who
-- haven't passed the given poll round. The one definition
-- get_reaction_window_pending_players, the Skip vote and the stall timeout
-- all read (0114). Issue #439: a Reaction Source is _is_reaction_source -- a
-- held Reaction card, or a live unspent Courage Token at Layer 0 -- so a
-- token holder is waited on, voted past and timed out like a card holder.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._reaction_window_waiting_on(
  p_round_id uuid, p_window_id uuid, p_poll_round integer
)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select rp.player_id
    from public.round_participants rp
   where rp.round_id = p_round_id
     and public._is_reaction_source(p_round_id, rp.player_id)
     and not public.has_passed_reaction_poll(p_window_id, p_poll_round, rp.player_id);
$$;

revoke execute on function public._reaction_window_waiting_on(uuid, uuid, integer) from public, anon, authenticated;
