-- submit_roll_as(p_round_id uuid, p_player_id text) -> integer
--
-- Admin-puppet twin of submit_roll, kept in lockstep. Verbatim from
-- migration 0101.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

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
  v_first_value integer;
  v_second_value integer;
  v_discarded_value integer;
  v_has_advantage boolean;
  v_has_disadvantage boolean;
  v_condition jsonb;
  v_cond_branch text;
  v_cond_adv_at integer;
  v_cond_dis_at integer;
  v_eff_advantage boolean;
  v_eff_disadvantage boolean;
  v_cancelled boolean;
  v_dice jsonb;
  v_fixed_applied boolean := false;   -- issue #317
  v_adv_ward_cast_id uuid;            -- issue #335: roll-domain ward pre-check
  v_adv_ward_card text;
  v_dis_ward_cast_id uuid;
  v_dis_ward_card text;
  v_adv_cast_seq bigint;
  v_dis_cast_seq bigint;
  v_adv_ward_blocked boolean := false;
  v_dis_ward_blocked boolean := false;
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
       and not (coalesce(effect_params, '{}'::jsonb) ? 'condition')
  );
  v_has_disadvantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = p_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  if v_layer = 0 then
    -- issue #320: a rest-of-day persistent advantage / disadvantage
    -- (Prophe-Tea) lives as a spell_active_effects projection row, not a
    -- spell_casts row. Fold a live one into the same booleans the round-scoped
    -- advantage cards set, so the two-dice draw / discarded_value /
    -- cancellation all apply.
    if not v_has_advantage then
      v_has_advantage := exists (
        select 1 from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
         where sae.room_id = v_room_id
           and sae.effect_kind = 'advantage'
           and sae.target_player_id = p_player_id
      );
    end if;
    if not v_has_disadvantage then
      v_has_disadvantage := exists (
        select 1 from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
         where sae.room_id = v_room_id
           and sae.effect_kind = 'disadvantage'
           and sae.target_player_id = p_player_id
      );
    end if;

    select casts.effect_params -> 'condition'
      into v_condition
      from public.spell_casts casts
     where casts.round_id = p_round_id and casts.target_player_id = p_player_id
       and casts.target_pending = false and casts.effect_kind = 'advantage'
       and casts.effect_params ? 'condition'
     limit 1;

    -- issue #335: mirror of submit_roll -- roll-domain ward pre-check for a
    -- static advantage / disadvantage. Kept in lockstep.
    if v_has_advantage then
      select min(casts.seq) into v_adv_cast_seq
        from public.spell_casts casts
       where casts.round_id = p_round_id and casts.target_player_id = p_player_id
         and casts.target_pending = false and casts.effect_kind = 'advantage'
         and not (coalesce(casts.effect_params, '{}'::jsonb) ? 'condition');
      if v_adv_cast_seq is not null then
        select g.ward_cast_id, g.ward_card_name
          into v_adv_ward_cast_id, v_adv_ward_card
          from public._rr_active_ward_gate(
                 v_room_id, p_player_id, 'roll', 'positive', p_round_id, v_adv_cast_seq) g;
        if found then
          v_has_advantage := false;
          v_adv_ward_blocked := true;
        end if;
      end if;
    end if;

    if v_has_disadvantage then
      select min(casts.seq) into v_dis_cast_seq
        from public.spell_casts casts
       where casts.round_id = p_round_id and casts.target_player_id = p_player_id
         and casts.target_pending = false and casts.effect_kind = 'disadvantage';
      if v_dis_cast_seq is not null then
        select g.ward_cast_id, g.ward_card_name
          into v_dis_ward_cast_id, v_dis_ward_card
          from public._rr_active_ward_gate(
                 v_room_id, p_player_id, 'roll', 'negative', p_round_id, v_dis_cast_seq) g;
        if found then
          v_has_disadvantage := false;
          v_dis_ward_blocked := true;
        end if;
      end if;
    end if;
  end if;

  v_value := floor(random() * 20 + 1)::integer;
  v_first_value := v_value;
  v_discarded_value := null;

  -- issue #317: fixed-roll shim. Records the before->after (order 0) and
  -- returns the constant die; a roll-domain ward instead records a `warded`
  -- marker and returns v_first_value with applied = false. A fixed die has
  -- nothing to take advantage / disadvantage on, so the blocks below are
  -- all guarded on `not v_fixed_applied`.
  select f.value, f.applied into v_value, v_fixed_applied
    from public._rr_apply_fixed_roll(p_round_id, p_player_id, v_layer, v_room_id, v_first_value) f;

  v_cond_branch := null;
  if v_condition is not null then
    v_cond_adv_at := coalesce((v_condition ->> 'advantage_at_or_above')::integer, 15);
    v_cond_dis_at := coalesce((v_condition ->> 'disadvantage_at_or_below')::integer, 5);
    if v_first_value >= v_cond_adv_at then
      v_cond_branch := 'advantage';
    elsif v_first_value <= v_cond_dis_at then
      v_cond_branch := 'disadvantage';
    else
      v_cond_branch := 'none';
    end if;
  end if;

  v_eff_advantage := v_has_advantage or v_cond_branch is not distinct from 'advantage';
  v_eff_disadvantage := v_has_disadvantage or v_cond_branch is not distinct from 'disadvantage';
  v_cancelled := v_eff_advantage and v_eff_disadvantage;

  if not v_fixed_applied and v_eff_advantage <> v_eff_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_eff_advantage then
      v_discarded_value := least(v_value, v_second_value);
      v_value := greatest(v_value, v_second_value);
    else
      v_discarded_value := greatest(v_value, v_second_value);
      v_value := least(v_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, discarded_value)
  values (p_round_id, p_player_id, v_layer, v_value, 'in_app', v_modifier, v_discarded_value);

  if not v_fixed_applied and (v_eff_advantage or v_eff_disadvantage or v_condition is not null
       or v_adv_ward_blocked or v_dis_ward_blocked) then
    if v_cancelled or v_second_value is null then
      v_dice := jsonb_build_array(v_first_value);
    else
      v_dice := jsonb_build_array(v_first_value, v_second_value);
    end if;

    update public.spell_casts casts
       set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', casts.effect_kind,
               'order', 1,
               'cancelled', v_cancelled,
               'dice', v_dice,
               'players', jsonb_build_array(
                 case
                   when (casts.effect_kind = 'advantage' and v_adv_ward_blocked)
                     or (casts.effect_kind = 'disadvantage' and v_dis_ward_blocked)
                   then jsonb_build_object(
                     'player_id', p_player_id,
                     'before', v_first_value,
                     'after', v_first_value,
                     'warded', true,
                     'would_be_after', v_first_value,
                     'ward_cast_id', case when casts.effect_kind = 'advantage'
                                          then v_adv_ward_cast_id else v_dis_ward_cast_id end,
                     'ward_card_name', case when casts.effect_kind = 'advantage'
                                            then v_adv_ward_card else v_dis_ward_card end
                   )
                   else jsonb_build_object(
                     'player_id', p_player_id,
                     'before', v_first_value,
                     'after', v_value
                   )
                 end
               )
             ))
     where casts.round_id = p_round_id
       and casts.target_player_id = p_player_id
       and casts.target_pending = false
       and casts.effect_kind in ('advantage', 'disadvantage')
       and not (coalesce(casts.effect_params, '{}'::jsonb) ? 'condition');

    if v_condition is not null then
      update public.spell_casts casts
         set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
               'roll_transform', jsonb_build_object(
                 'kind', 'advantage',
                 'order', 1,
                 'cancelled', v_cancelled,
                 'condition', jsonb_build_object(
                   'first_die', v_first_value,
                   'branch', v_cond_branch,
                   'advantage_at_or_above', v_cond_adv_at,
                   'disadvantage_at_or_below', v_cond_dis_at
                 ),
                 'dice', v_dice,
                 'players', jsonb_build_array(jsonb_build_object(
                   'player_id', p_player_id,
                   'before', v_first_value,
                   'after', v_value
                 ))
               ))
       where casts.round_id = p_round_id
         and casts.target_player_id = p_player_id
         and casts.target_pending = false
         and casts.effect_kind = 'advantage'
         and casts.effect_params ? 'condition';
    end if;
  end if;

  return v_value;
end;
$$;

revoke execute on function public.submit_roll_as(uuid, text) from public, anon;
grant execute on function public.submit_roll_as(uuid, text) to authenticated;
