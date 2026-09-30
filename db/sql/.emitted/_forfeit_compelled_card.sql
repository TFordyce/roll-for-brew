-- _forfeit_compelled_card
--
-- Forfeit a player's outstanding compelled cast: the card goes back to the
-- deck as if played, and a no-effect `forfeit` row points at Brewmageddon.
-- Returns false when the player owes nothing (already cast, or released).
create or replace function public._forfeit_compelled_card(
  p_round_id uuid, p_player_id text, p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  select o.card_instance_id, o.casting_time, o.brewmageddon_cast_id
    into v_owed
    from public._compelled_outstanding(p_round_id) o
   where o.player_id = p_player_id
   limit 1;

  if not found then
    return false;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_owed.card_instance_id
     and held_by_player = p_player_id
     and location = 'held';

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id,
    effect_kind, effect_params, cast_inputs
  )
  values (
    p_round_id, p_player_id, v_owed.card_instance_id, p_player_id,
    'forfeit', '{}'::jsonb,
    jsonb_build_object(
      'compelled_by', v_owed.brewmageddon_cast_id,
      'casting_time', v_owed.casting_time,
      'reason', p_reason)
  );

  return true;
end;
$$;

revoke execute on function public._forfeit_compelled_card(uuid, text, text) from public, anon, authenticated;
