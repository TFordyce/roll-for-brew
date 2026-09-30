-- get_my_compelled_cast
--
-- The caller's own outstanding compelled cast, for the prompt: which card,
-- whether it is an Action (cast now) or a Reaction (cast in the window), and
-- who played Brewmageddon. No row when the caller owes nothing.
create or replace function public.get_my_compelled_cast(p_round_id uuid)
returns table (casting_time text, card_name text, brewmageddon_caster_id text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select o.casting_time, sc.name, bm.caster_id
      from public._compelled_outstanding(p_round_id) o
      join public.spell_deck_instances sdi on sdi.id = o.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
      join public.spell_casts bm on bm.id = o.brewmageddon_cast_id
     where o.player_id = v_player_id;
end;
$$;

revoke execute on function public.get_my_compelled_cast(uuid) from public, anon;
grant execute on function public.get_my_compelled_cast(uuid) to authenticated;
