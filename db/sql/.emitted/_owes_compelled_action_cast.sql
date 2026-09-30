-- _owes_compelled_action_cast
--
-- Whether the caller has a compelled Action cast to make now (the Compelled
-- Cast step). cast_spell_card and end_active_effect read this to accept a
-- cast while the round is closed.
create or replace function public._owes_compelled_action_cast(p_round_id uuid, p_player_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.player_id = p_player_id and o.casting_time = 'A'
  );
$$;

revoke execute on function public._owes_compelled_action_cast(uuid, text) from public, anon, authenticated;
