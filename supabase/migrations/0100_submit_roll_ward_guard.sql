-- Ward phase fast-follow (issue #335, follows #309 / migration 0082, spec
-- #302 §7): a roll-domain ward now also gates a STATIC advantage / disadvantage
-- that lands eagerly through submit_roll / submit_roll_as.
--
-- #309 wired the earlier-seq roll-domain ward pre-check (_rr_active_ward_gate)
-- into the reaction-window transforms (apply_forced_reroll / apply_roll_flip /
-- apply_roll_swap) but deliberately left submit_roll alone, where
-- advantage / disadvantage resolves at roll time. So a roll-domain ward
-- (Jinxed Biscuit polarity:["positive"], Cast-Iron Kettle polarity:["negative"])
-- did not block an advantage / disadvantage drawn at submit_roll.
--
-- This migration re-emits submit_roll / submit_roll_as from 0097 with one
-- addition, byte-for-byte 0097 otherwise:
--
--   * Before the roll, for a roller with a plain (non-conditional) advantage
--     spell_casts row this round, probe _rr_active_ward_gate(room, roller,
--     'roll', 'positive', round, <advantage cast seq>). If a matching,
--     earlier-seq (or prior-round / persistent) ward is live, clear
--     v_has_advantage so the second d20 is never drawn, and record a `warded`
--     players[] entry on the advantage cast's cast_inputs.roll_transform
--     (before == after == the natural roll, plus would_be_after / ward_cast_id
--     / ward_card_name) exactly as the eager reaction-window shims do. The
--     disadvantage side is the mirror with polarity 'negative'.
--
-- resolve_round Phase 3 already turns such a `warded` roll_transform entry into
-- a `warded` Trace step (0099, the generic advantage / disadvantage branch), so
-- no resolver change is needed and no new primitive is introduced.
--
-- Out of scope (documented follow-ups, consistent with #335): conditional
-- advantage (Gambler's Infusion) is dynamic -- its polarity depends on the
-- first die -- so it is not gated here; and a projection-only persistent
-- advantage (Prophe-Tea in a round after its cast) has no spell_casts row to
-- carry the `warded` marker, so it still rolls unwarded until the spec §5
-- "ward projection lives in the resolver" end state.
--
-- Migration numbering: master's highest after the rebuild/effect-resolver
-- merge (PR #364) and the 0099 fix (PR #365) is 0099. This is 0100.

-- ---------------------------------------------------------------------------
-- submit_roll(uuid)
-- ---------------------------------------------------------------------------
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
  v_first_value integer;
  v_second_value integer;
  v_discarded_value integer;
  v_has_advantage boolean;      -- a PLAIN advantage cast (no condition)
  v_has_disadvantage boolean;
  v_condition jsonb;            -- effect_params.condition of a conditional cast
  v_cond_branch text;          -- 'advantage' | 'disadvantage' | 'none' | null
  v_cond_adv_at integer;
  v_cond_dis_at integer;
  v_eff_advantage boolean;     -- plain OR condition-selected advantage
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

  -- Plain (unconditional) advantage / disadvantage casts. The `? 'condition'`
  -- exclusion is on the advantage side only: a conditional cast is always
  -- effect_kind 'advantage' (Gambler's Infusion; there is no conditional
  -- disadvantage card), so the disadvantage probe needs no matching guard.
  v_has_advantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'advantage'
       and not (coalesce(effect_params, '{}'::jsonb) ? 'condition')
  );
  v_has_disadvantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
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
           and sae.target_player_id = v_player_id
      );
    end if;
    if not v_has_disadvantage then
      v_has_disadvantage := exists (
        select 1 from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
         where sae.room_id = v_room_id
           and sae.effect_kind = 'disadvantage'
           and sae.target_player_id = v_player_id
      );
    end if;

    select casts.effect_params -> 'condition'
      into v_condition
      from public.spell_casts casts
     where casts.round_id = p_round_id and casts.target_player_id = v_player_id
       and casts.target_pending = false and casts.effect_kind = 'advantage'
       and casts.effect_params ? 'condition'
     limit 1;

    -- issue #335 (fast-follow to #309): a live roll-domain ward on the roller
    -- whose polarity matches a STATIC advantage (positive) / disadvantage
    -- (negative) spell_casts row wards it off before the roll, subject to the
    -- earlier-seq rule (_rr_active_ward_gate, shared with the reaction-window
    -- shims). Clearing the boolean suppresses the second d20; the `warded`
    -- players[] entry recorded below makes resolve_round Phase 3 emit the
    -- `warded` step. Conditional advantage is dynamic (out of scope); a
    -- projection-only persistent advantage has no cast row to mark (follow-up).
    if v_has_advantage then
      select min(casts.seq) into v_adv_cast_seq
        from public.spell_casts casts
       where casts.round_id = p_round_id and casts.target_player_id = v_player_id
         and casts.target_pending = false and casts.effect_kind = 'advantage'
         and not (coalesce(casts.effect_params, '{}'::jsonb) ? 'condition');
      if v_adv_cast_seq is not null then
        select g.ward_cast_id, g.ward_card_name
          into v_adv_ward_cast_id, v_adv_ward_card
          from public._rr_active_ward_gate(
                 v_room_id, v_player_id, 'roll', 'positive', p_round_id, v_adv_cast_seq) g;
        if found then
          v_has_advantage := false;
          v_adv_ward_blocked := true;
        end if;
      end if;
    end if;

    if v_has_disadvantage then
      select min(casts.seq) into v_dis_cast_seq
        from public.spell_casts casts
       where casts.round_id = p_round_id and casts.target_player_id = v_player_id
         and casts.target_pending = false and casts.effect_kind = 'disadvantage';
      if v_dis_cast_seq is not null then
        select g.ward_cast_id, g.ward_card_name
          into v_dis_ward_cast_id, v_dis_ward_card
          from public._rr_active_ward_gate(
                 v_room_id, v_player_id, 'roll', 'negative', p_round_id, v_dis_cast_seq) g;
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
    from public._rr_apply_fixed_roll(p_round_id, v_player_id, v_layer, v_room_id, v_first_value) f;

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
  values (p_round_id, v_player_id, v_layer, v_value, 'in_app', v_modifier, v_discarded_value);

  -- Record the roll transform onto the advantage / disadvantage cast(s).
  -- issue #335: also record when the only effect was warded off at roll time,
  -- so Phase 3 still has a roll_transform entry to emit the `warded` step from.
  if not v_fixed_applied and (v_eff_advantage or v_eff_disadvantage or v_condition is not null
       or v_adv_ward_blocked or v_dis_ward_blocked) then
    if v_cancelled or v_second_value is null then
      v_dice := jsonb_build_array(v_first_value);
    else
      v_dice := jsonb_build_array(v_first_value, v_second_value);
    end if;

    -- Plain advantage / disadvantage casts (Sugar Rush, Slipped Spoon, ...).
    -- issue #335: a cast whose kind was warded off records a `warded` entry
    -- (roll untouched: before == after) instead of the normal before -> after.
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
                     'player_id', v_player_id,
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
                     'player_id', v_player_id,
                     'before', v_first_value,
                     'after', v_value
                   )
                 end
               )
             ))
     where casts.round_id = p_round_id
       and casts.target_player_id = v_player_id
       and casts.target_pending = false
       and casts.effect_kind in ('advantage', 'disadvantage')
       and not (coalesce(casts.effect_params, '{}'::jsonb) ? 'condition');

    -- Conditional advantage cast (Gambler's Infusion): same shape plus the
    -- `condition` object naming the branch the first die selected.
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
                   'player_id', v_player_id,
                   'before', v_first_value,
                   'after', v_value
                 ))
               ))
       where casts.round_id = p_round_id
         and casts.target_player_id = v_player_id
         and casts.target_pending = false
         and casts.effect_kind = 'advantage'
         and casts.effect_params ? 'condition';
    end if;
  end if;

  return v_value;
end;
$$;

revoke execute on function public.submit_roll(uuid) from public, anon;
grant execute on function public.submit_roll(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_roll_as(uuid, text) -- admin-puppet twin, kept in lockstep.
-- ---------------------------------------------------------------------------
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
