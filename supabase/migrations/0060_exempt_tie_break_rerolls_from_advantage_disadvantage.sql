-- Tie-break rerolls should be exempt from spell effects and reaction casts
-- (issue #219, part 1/3 — see layerResolution.ts for parts 2/3:
-- composeModifier/openReactionWindow scoped to layer 0). submit_roll/
-- submit_roll_as (latest: 0049_persist_discarded_advantage_disadvantage_roll.sql)
-- check for an active advantage/disadvantage spell_casts row targeting the
-- round with no layer filter, so a tie-break reroll (v_layer > 0) currently
-- draws two d20s and keeps the advantaged/disadvantaged one, exactly like
-- the original roll (v_layer = 0). Scope both exists checks to the original
-- roll only — a tie-break reroll always draws a single, unmodified d20.

create or replace function public.submit_roll(p_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_modifier integer;
  v_value integer;
  v_second_value integer;
  v_discarded_value integer;
  v_has_advantage boolean;
  v_has_disadvantage boolean;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_roll: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_roll: round is not closed for rolling'
      using errcode = 'RFB01';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'submit_roll: caller is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = v_player_id;
  v_modifier := coalesce(v_modifier, 0);

  v_has_advantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'advantage'
  );
  v_has_disadvantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  v_value := floor(random() * 20 + 1)::integer;
  v_discarded_value := null;

  if v_has_advantage <> v_has_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_has_advantage then
      v_discarded_value := least(v_value, v_second_value);
      v_value := greatest(v_value, v_second_value);
    else
      v_discarded_value := greatest(v_value, v_second_value);
      v_value := least(v_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, discarded_value)
  values (p_round_id, v_player_id, v_layer, v_value, 'in_app', v_modifier, v_discarded_value);

  return v_value;
end;
$$;

revoke execute on function public.submit_roll(uuid) from public, anon;
grant execute on function public.submit_roll(uuid) to authenticated;

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
  v_discarded_value integer;
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
  v_modifier := coalesce(v_modifier, 0);

  v_has_advantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = p_player_id
       and target_pending = false and effect_kind = 'advantage'
  );
  v_has_disadvantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = p_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  v_value := floor(random() * 20 + 1)::integer;
  v_discarded_value := null;

  if v_has_advantage <> v_has_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_has_advantage then
      v_discarded_value := least(v_value, v_second_value);
      v_value := greatest(v_value, v_second_value);
    else
      v_discarded_value := greatest(v_value, v_second_value);
      v_value := least(v_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, discarded_value)
  values (p_round_id, p_player_id, v_layer, v_value, 'in_app', v_modifier, v_discarded_value);

  return v_value;
end;
$$;

revoke execute on function public.submit_roll_as(uuid, text) from public, anon;
grant execute on function public.submit_roll_as(uuid, text) to authenticated;
