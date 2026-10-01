-- end_active_effect
--
-- A Detox (dispel) is played through its own RPC; a compelled Detox holder
-- plays it in the Compelled Cast step like any other Action card. An
-- is_undispellable effect (issue #428) is refused. Otherwise unchanged (0084).
create or replace function public.end_active_effect(p_round_id uuid, p_effect_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_instance_id uuid;
  v_casting_time text;
  v_effect_kind text;
  v_effect_params jsonb;
  v_tiers text[];
  v_target_player_id text;
  v_target_tier text;
  v_target_room_id uuid;
  v_undispellable boolean;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id from public.rounds where id = p_round_id;

  if v_status is null then
    raise exception 'end_active_effect: round not found';
  end if;

  if v_status <> 'open'
     and not (v_status = 'closed' and public._owes_compelled_action_cast(p_round_id, v_player_id)) then
    raise exception 'end_active_effect: round is not open for pre-roll casting'
      using errcode = 'RFB03';
  end if;

  select gh.instance_id, gh.casting_time, gh.effect_kind, gh.effect_params
    into v_instance_id, v_casting_time, v_effect_kind, v_effect_params
    from public.get_held_card_effect(v_player_id) gh;

  if v_instance_id is null then
    raise exception 'end_active_effect: caller is not holding a card';
  end if;

  if v_effect_kind <> 'dispel' then
    raise exception 'end_active_effect: held card cannot end active effects';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'end_active_effect: only Action cards can be cast pre-roll';
  end if;

  select array(select jsonb_array_elements_text(v_effect_params -> 'tiers')) into v_tiers;

  select sae.target_player_id, sc2.tier, sae.room_id, sae.is_undispellable
    into v_target_player_id, v_target_tier, v_target_room_id, v_undispellable
    from public.spell_active_effects sae
    join public.spell_cards sc2 on sc2.id = sae.card_id
   where sae.id = p_effect_id;

  if v_target_player_id is null then
    raise exception 'end_active_effect: active effect not found';
  end if;

  -- issue #428: The Last Cuppa's immunity can't be dispelled. The picker
  -- (get_dispellable_active_effects) never offers it; this refuses a direct call.
  if v_undispellable then
    raise exception 'end_active_effect: this effect cannot be dispelled';
  end if;

  if v_target_room_id <> v_room_id then
    raise exception 'end_active_effect: active effect is not in this room';
  end if;

  if not (v_target_tier = any(v_tiers)) then
    raise exception 'end_active_effect: held card cannot end a % effect', v_target_tier;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params
  )
  values (
    p_round_id, v_player_id, v_instance_id, v_target_player_id, 'dispel',
    jsonb_build_object('ended_effect_id', p_effect_id)
  );

  perform public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, null);
end;
$$;
