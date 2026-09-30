-- _fix_compelled_set
--
-- Fix the compelled set of every Brewmageddon cast in the round (called by
-- close_round once the roster is locked), then forfeit each compelled Action
-- card with no legal target. A Reaction card's target is checked when the
-- Layer-0 window opens instead (_forfeit_untargetable_compelled_reactions).
create or replace function public._fix_compelled_set(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  update public.spell_casts bm
     set cast_inputs = coalesce(bm.cast_inputs, '{}'::jsonb) || jsonb_build_object(
           'compelled', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'player_id', rp.player_id,
                      'card_instance_id', sdi.id,
                      'casting_time', sc.casting_time)
                    order by rp.player_id)
               from public.round_participants rp
               join public.spell_deck_instances sdi
                 on sdi.held_by_player = rp.player_id and sdi.location = 'held'
               join public.spell_cards sc on sc.id = sdi.card_id
              where rp.round_id = p_round_id and rp.excluded_at is null
           ), '[]'::jsonb))
   where bm.round_id = p_round_id
     and bm.effect_kind = 'compel_cast'
     and not bm.negated;

  for v_owed in
    select o.player_id, o.card_instance_id
      from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
  loop
    if not public._compelled_card_has_legal_target(p_round_id, v_owed.player_id, v_owed.card_instance_id) then
      perform public._forfeit_compelled_card(p_round_id, v_owed.player_id, 'no_legal_target');
    end if;
  end loop;
end;
$$;

revoke execute on function public._fix_compelled_set(uuid) from public, anon, authenticated;
