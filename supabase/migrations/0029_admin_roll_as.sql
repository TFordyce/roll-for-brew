-- Admin "roll for others" in the Test Room: lets an admin submit a roll (or
-- manual value) directly for any pending roller, without first switching
-- Acting As to become them (issue #102 follow-up — testing a round with
-- several Test Players otherwise means several act-as/roll/act-as-back round
-- trips just to get everyone's dice in). Mirrors submit_roll/submit_manual_roll
-- (0026) almost exactly, but takes the target player explicitly instead of
-- resolving it from current_player_id()/admin_acting_as, and gates on the
-- caller being an admin acting on a Test Room round rather than on the
-- target being the caller's own puppeted identity.
create or replace function public.submit_roll_as(p_round_id uuid, p_player_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_modifier integer;
  v_value integer;
  v_second_value integer;
  v_has_advantage boolean;
  v_has_disadvantage boolean;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'submit_roll_as: caller is not an admin';
  end if;

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_roll_as: round not found';
  end if;

  if not exists (select 1 from public.rooms where id = v_room_id and is_test) then
    raise exception 'submit_roll_as: round is not in the Test Room';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_roll_as: round is not closed for rolling'
      using errcode = 'RFB01';
  end if;

  if not public.is_expected_layer_roller(p_round_id, p_player_id, v_layer) then
    raise exception 'submit_roll_as: target player is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = p_player_id;

  v_has_advantage := exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = p_player_id
       and target_pending = false and effect_kind = 'advantage'
  );
  v_has_disadvantage := exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = p_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  v_value := floor(random() * 20 + 1)::integer;

  if v_has_advantage <> v_has_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_has_advantage then
      v_value := greatest(v_value, v_second_value);
    else
      v_value := least(v_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, p_player_id, v_layer, v_value, 'in_app', v_modifier);

  return v_value;
end;
$$;

revoke execute on function public.submit_roll_as(uuid, text) from public, anon;
grant execute on function public.submit_roll_as(uuid, text) to authenticated;

create or replace function public.submit_manual_roll_as(p_round_id uuid, p_player_id text, p_value integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_modifier integer;
begin
  if p_value is null or p_value < 1 or p_value > 20 then
    raise exception 'submit_manual_roll_as: value must be between 1 and 20';
  end if;

  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'submit_manual_roll_as: caller is not an admin';
  end if;

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_manual_roll_as: round not found';
  end if;

  if not exists (select 1 from public.rooms where id = v_room_id and is_test) then
    raise exception 'submit_manual_roll_as: round is not in the Test Room';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_manual_roll_as: round is not closed for rolling'
      using errcode = 'RFB01';
  end if;

  if not public.is_expected_layer_roller(p_round_id, p_player_id, v_layer) then
    raise exception 'submit_manual_roll_as: target player is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = p_player_id;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, p_player_id, v_layer, p_value, 'manual', v_modifier);
end;
$$;

revoke execute on function public.submit_manual_roll_as(uuid, text, integer) from public, anon;
grant execute on function public.submit_manual_roll_as(uuid, text, integer) to authenticated;
