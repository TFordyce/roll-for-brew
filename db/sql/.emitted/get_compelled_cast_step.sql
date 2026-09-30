-- get_compelled_cast_step
--
-- The Compelled Cast step as the table sees it: who still owes an Action
-- cast (rolling is held while this is non-empty), and when the step ended --
-- the last compelled Action cast or Forfeit -- or null when the round had no
-- step. Layer 0's roll stall clock runs from ended_at when there is one, so
-- a long step never counts against the rollers.
create or replace function public.get_compelled_cast_step(p_round_id uuid)
returns table (waiting_on text[], ended_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(array(
      select o.player_id from public._compelled_outstanding(p_round_id) o
       where o.casting_time = 'A'
       order by o.player_id), '{}'::text[]),
    (select max(c.cast_at)
       from public.spell_casts c
      where c.round_id = p_round_id
        and c.reaction_window_id is null
        and c.cast_inputs ? 'compelled_by'
        and (c.effect_kind is distinct from 'forfeit' or c.cast_inputs ->> 'casting_time' = 'A'));
$$;

revoke execute on function public.get_compelled_cast_step(uuid) from public, anon;
grant execute on function public.get_compelled_cast_step(uuid) to authenticated;
