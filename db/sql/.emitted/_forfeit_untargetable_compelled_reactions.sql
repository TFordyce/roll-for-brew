-- _forfeit_untargetable_compelled_reactions
--
-- Forfeit each compelled Reaction card with no legal target. advance_layer
-- calls this just before it opens the Layer-0 window.
create or replace function public._forfeit_untargetable_compelled_reactions(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  for v_owed in
    select o.player_id, o.card_instance_id
      from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'R'
  loop
    if not public._compelled_card_has_legal_target(p_round_id, v_owed.player_id, v_owed.card_instance_id) then
      perform public._forfeit_compelled_card(p_round_id, v_owed.player_id, 'no_legal_target');
    end if;
  end loop;
end;
$$;

revoke execute on function public._forfeit_untargetable_compelled_reactions(uuid) from public, anon, authenticated;
