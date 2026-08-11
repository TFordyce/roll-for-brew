-- Issue #252: gives a dice_modifier spell effect (Six Sugars' 1d6, Cold
-- Tea's and Slipped Spoon's 1d4) the same in-app/manual/both roll-input
-- choice the main d20 roll already offers via roll_input_mode, instead of
-- resolving the die with a synchronous server-side random() the affected
-- player has no say in. See the new "Pending Spell Die" glossary entry in
-- CONTEXT.md for the target shape of this state.
--
-- cast_spell_card (latest prior definition: 0065) and cast_reaction_spell_card
-- (latest prior definition: 0033) are redefined below to leave resolved_value
-- null for a dice_modifier effect's CASTER/TARGET-role row instead of rolling
-- it inline — resolved_value is already nullable and already used to mean
-- "not yet known" for a deferred-target row, so no new column is needed:
-- effect_kind = 'dice_modifier' and resolved_value is null now means
-- "awaiting the affected player's roll" instead of "already rolled".
--
-- Deliberately unchanged: the CHOSEN_PLAYERS and TABLE/ALL_OTHER_PLAYERS
-- dice_modifier branches in both functions (no catalog card uses either
-- shape with dice_modifier today, confirmed by grepping effect_kind =
-- 'dice_modifier' in every catalog migration — only Six Sugars/Cold Tea/
-- Slipped Spoon, all CASTER-role) — resolving those immediately, as before,
-- is out of scope per the issue's acceptance criteria.
create or replace function public.cast_spell_card(
  p_round_id uuid, p_target_player_id text default null,
  p_chosen_player_ids text[] default null, p_declared_number integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_instance_id uuid;
  v_card_id uuid;
  v_casting_time text;
  v_target_stamp text;
  v_target_pending boolean := false;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_pending boolean;
  v_row_cast_id uuid;
  v_resolved_value numeric;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
  v_effect_params jsonb;
  v_max_targets integer;
  v_chosen_id text;
  v_branch integer;
  v_other_id text;
  v_extreme_low text;
  v_extreme_high text;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id from public.rounds where id = p_round_id;

  if v_status is null then
    raise exception 'cast_spell_card: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'cast_spell_card: round is not open for pre-roll casting'
      using errcode = 'RFB03';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'cast_spell_card: caller is not a participant in this round';
  end if;

  select sdi.id, sc.id, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_casting_time, v_target_stamp
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'cast_spell_card: only Action cards can be cast pre-roll';
  end if;

  if v_target_stamp = 'SELF' then
    if p_target_player_id is not null and p_target_player_id <> v_player_id then
      raise exception 'cast_spell_card: this card can only target yourself';
    end if;
    v_final_target := v_player_id;
  elsif v_target_stamp in ('OPPONENT', 'PLAYER') then
    if p_target_player_id is null then
      v_target_pending := true;
      v_final_target := null;
    else
      if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
        raise exception 'cast_spell_card: this card cannot target yourself';
      end if;
      if not exists (
        select 1 from public.round_participants
         where round_id = p_round_id and player_id = p_target_player_id
      ) then
        raise exception 'cast_spell_card: target is not a participant in this round';
      end if;
    end if;
  elsif v_target_stamp = 'CHOSEN_PLAYERS' then
    if p_chosen_player_ids is null or array_length(p_chosen_player_ids, 1) is null then
      raise exception 'cast_spell_card: this card requires at least one chosen player';
    end if;
    if array_length(p_chosen_player_ids, 1) <> (
      select count(distinct x) from unnest(p_chosen_player_ids) x
    ) then
      raise exception 'cast_spell_card: chosen players must be distinct';
    end if;
    foreach v_chosen_id in array p_chosen_player_ids loop
      if not exists (
        select 1 from public.round_participants
         where round_id = p_round_id and player_id = v_chosen_id
      ) then
        raise exception 'cast_spell_card: chosen player is not a participant in this round';
      end if;
    end loop;
  elsif v_target_stamp in ('TABLE', 'WILD') then
    v_final_target := null;
  else
    raise exception 'cast_spell_card: % -targeted cards cannot be cast pre-roll yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  -- WILD is fully special-cased: the six branches are mutually exclusive
  -- alternatives chosen by a d6 roll at cast time, not simultaneous
  -- spell_card_effects rows, so this bypasses the generic per-effect loop
  -- below entirely (that loop explicitly excludes target_role = 'WILD').
  if v_target_stamp = 'WILD' then
    v_branch := floor(random() * 6 + 1)::integer;

    if v_branch = 1 then
      update public.room_players set modifier = 0 where room_id = v_room_id;
      v_effect_params := '{}'::jsonb;
    elsif v_branch = 2 then
      update public.room_players set modifier = modifier + 3
       where room_id = v_room_id and player_id = v_player_id;
      v_effect_params := '{"delta": 3}'::jsonb;
    elsif v_branch = 3 then
      select player_id into v_other_id
        from public.room_players
       where room_id = v_room_id and player_id <> v_player_id
       order by random()
       limit 1;
      if v_other_id is not null then
        perform public.swap_room_player_modifiers(v_room_id, v_player_id, v_other_id);
        v_effect_params := jsonb_build_object('swapped_with', v_other_id);
      else
        v_effect_params := '{}'::jsonb;
      end if;
    elsif v_branch = 4 then
      -- "Everyone rerolls" — nobody's rolled yet (WBS is cast pre-roll), so
      -- this arms a table-wide forced_reroll placeholder the same as Tea-M
      -- Reroll, fanned out to the final roster by close_round below and
      -- applied once the round's first rolls are in (finalizeReactionWindow
      -- already applies any un-negated forced_reroll cast for the layer,
      -- regardless of whether it was armed pre-roll or as a reaction).
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, true,
        'forced_reroll', '{}'::jsonb, 'TABLE'
      );
      v_effect_params := '{}'::jsonb;
    elsif v_branch = 5 then
      select rp.player_id into v_extreme_high
        from public.round_participants rp
        join public.room_players rpl on rpl.room_id = v_room_id and rpl.player_id = rp.player_id
       where rp.round_id = p_round_id
       order by rpl.modifier desc, rp.player_id
       limit 1;
      select rp.player_id into v_extreme_low
        from public.round_participants rp
        join public.room_players rpl on rpl.room_id = v_room_id and rpl.player_id = rp.player_id
       where rp.round_id = p_round_id
       order by rpl.modifier asc, rp.player_id
       limit 1;
      if v_extreme_high is not null and v_extreme_low is not null and v_extreme_high <> v_extreme_low then
        perform public.swap_room_player_modifiers(v_room_id, v_extreme_high, v_extreme_low);
        v_effect_params := jsonb_build_object('swapped', jsonb_build_array(v_extreme_high, v_extreme_low));
      else
        v_effect_params := '{}'::jsonb;
      end if;
    else
      -- Branch 6: choose who makes tea this round. p_target_player_id may
      -- already be known (client asked up front); otherwise this defers the
      -- same way OPPONENT/PLAYER cards do, and the caster fills it in later
      -- via set_spell_cast_target once the round closes.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, p_target_player_id, p_target_player_id is null,
        'tea_maker_override', '{"mode": "chosen"}'::jsonb, 'WILD'
      )
      returning id into v_cast_id;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, resolved_value, effect_kind, effect_params
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_branch, 'wild_dispatch', '{"branch": 6}'::jsonb);

      return v_cast_id;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, resolved_value, effect_kind, effect_params
    )
    values (p_round_id, v_player_id, v_instance_id, null, v_branch, 'wild_dispatch', v_effect_params)
    returning id into v_cast_id;

    return v_cast_id;
  end if;

  for v_effect in
    select target_role, effect_kind, effect_params
      from public.spell_card_effects
     where card_id = v_card_id and target_role <> 'WILD'
     order by ordinal
  loop
    v_effect_params := v_effect.effect_params;

    if v_effect.effect_kind = 'declared_number_tea_maker' then
      if p_declared_number is null or p_declared_number < 1 or p_declared_number > 20 then
        raise exception 'cast_spell_card: this card requires a declared number between 1 and 20';
      end if;
      v_effect_params := jsonb_build_object('number', p_declared_number);

      insert into public.spell_active_effects (
        room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining
      )
      values (v_room_id, v_player_id, v_player_id, null, v_card_id, v_effect.effect_kind, v_effect_params, 9999);

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, target_role
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_effect.effect_kind, v_effect_params, v_effect.target_role)
      returning id into v_row_cast_id;

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    end if;

    if v_effect.target_role = 'CASTER' then
      v_row_target := v_player_id;
      v_row_pending := false;
    elsif v_effect.target_role = 'TARGET' then
      v_row_target := v_final_target;
      v_row_pending := v_target_pending;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
      and v_effect.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'forced_reroll') then
      -- Deferred: fanned out to the final roster by close_round below.
      -- (unchanged: still resolved eagerly if it were dice_modifier — no
      -- catalog card uses this shape today, see header comment.)
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, true,
        v_effect.effect_kind, v_effect_params, v_effect.target_role
      )
      returning id into v_row_cast_id;

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS') then
      -- Single table-wide event (roll_swap/roll_flip/lowest_gains_highest_
      -- modifier/tea_maker_override) — no per-player row needed.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, target_role
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_effect.effect_kind, v_effect_params, v_effect.target_role)
      returning id into v_row_cast_id;

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    elsif v_effect.target_role = 'CHOSEN_PLAYERS' then
      v_max_targets := coalesce((v_effect_params ->> 'max_targets')::integer, array_length(p_chosen_player_ids, 1));
      if array_length(p_chosen_player_ids, 1) > v_max_targets then
        raise exception 'cast_spell_card: this card can only target up to % players', v_max_targets;
      end if;

      foreach v_chosen_id in array p_chosen_player_ids loop
        v_resolved_value := null;

        -- Unchanged: CHOSEN_PLAYERS dice_modifier still resolves eagerly —
        -- no catalog card uses this shape today, see header comment.
        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
          v_dice_sign := coalesce((v_effect_params ->> 'sign')::integer, 1);

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_resolved_value := v_roll_total * v_dice_sign;
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, resolved_value, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_chosen_id, false,
          v_effect.effect_kind, v_effect_params, v_resolved_value, v_effect.target_role
        )
        returning id into v_row_cast_id;

        if v_cast_id is null then
          v_cast_id := v_row_cast_id;
        end if;

        perform public.record_active_effect_if_persistent(
          v_room_id, v_player_id, v_chosen_id, v_card_id,
          v_effect.effect_kind, v_effect_params, v_row_cast_id
        );
      end loop;

      continue;
    else
      v_row_target := v_final_target;
      v_row_pending := v_target_pending;
    end if;

    -- dice_modifier (CASTER/TARGET role) is left resolved_value = null here
    -- (issue #252) — the affected player supplies it afterward via
    -- resolve_pending_spell_die_in_app/_manual below, instead of it being
    -- rolled inline with no player input.
    v_resolved_value := null;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, resolved_value, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, v_row_pending,
      v_effect.effect_kind, v_effect_params, v_resolved_value, v_effect.target_role
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_row_target is not null then
      perform public.record_active_effect_if_persistent(
        v_room_id, v_player_id, v_row_target, v_card_id,
        v_effect.effect_kind, v_effect_params, v_row_cast_id
      );
    end if;
  end loop;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_spell_card(uuid, text, text[], integer) from public, anon;
grant execute on function public.cast_spell_card(uuid, text, text[], integer) to authenticated;

-- Same "leave dice_modifier's resolved_value null" change as cast_spell_card
-- above, applied to cast_reaction_spell_card's own CASTER/TARGET-role branch
-- (Slipped Spoon's 1d4 today). Its TABLE/ALL_OTHER_PLAYERS dice_modifier fan-
-- out branch is left eagerly-resolving, same rationale as cast_spell_card's.
create or replace function public.cast_reaction_spell_card(
  p_round_id uuid, p_target_player_id text default null, p_target_cast_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_instance_id uuid;
  v_card_id uuid;
  v_casting_time text;
  v_target_stamp text;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_cast_id uuid;
  v_resolved_value numeric;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
  v_target_tier text;
  v_target_target_player text;
  v_dc integer;
  v_roll integer;
  v_participant record;
begin
  v_player_id := public.current_player_id(p_round_id);

  select id into v_window_id
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'cast_reaction_spell_card: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'cast_reaction_spell_card: caller is not a participant in this round';
  end if;

  select sdi.id, sc.id, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_casting_time, v_target_stamp
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_reaction_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'R' then
    raise exception 'cast_reaction_spell_card: only Reaction cards can be cast into a reaction window';
  end if;

  if v_target_stamp = 'CARD' then
    if p_target_cast_id is null then
      raise exception 'cast_reaction_spell_card: this card requires a target cast';
    end if;
    select casts.target_player_id, sc2.tier
      into v_target_target_player, v_target_tier
      from public.spell_casts casts
      join public.spell_deck_instances sdi2 on sdi2.id = casts.card_instance_id
      join public.spell_cards sc2 on sc2.id = sdi2.card_id
     where casts.id = p_target_cast_id and casts.round_id = p_round_id;

    if v_target_tier is null then
      raise exception 'cast_reaction_spell_card: target cast not found in this round';
    end if;
    v_final_target := null;
  elsif v_target_stamp = 'SELF' then
    v_final_target := v_player_id;
  elsif v_target_stamp in ('OPPONENT', 'PLAYER') then
    if p_target_player_id is null then
      raise exception 'cast_reaction_spell_card: this card requires a target player';
    end if;
    if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
      raise exception 'cast_reaction_spell_card: this card cannot target yourself';
    end if;
    if not exists (
      select 1 from public.round_participants
       where round_id = p_round_id and player_id = p_target_player_id
    ) then
      raise exception 'cast_reaction_spell_card: target is not a participant in this round';
    end if;
  elsif v_target_stamp = 'TABLE' then
    v_final_target := null;
  else
    raise exception 'cast_reaction_spell_card: % -targeted cards cannot be cast as a reaction yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  for v_effect in
    select target_role, effect_kind, effect_params
      from public.spell_card_effects
     where card_id = v_card_id
     order by ordinal
  loop
    if v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
      and v_effect.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'forced_reroll') then
      for v_participant in
        select rp.player_id
          from public.round_participants rp
         where rp.round_id = p_round_id
           and (v_effect.target_role <> 'ALL_OTHER_PLAYERS' or rp.player_id <> v_player_id)
      loop
        v_resolved_value := null;

        -- Unchanged: still resolved eagerly, see header comment.
        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
          v_dice_sign := coalesce((v_effect.effect_params ->> 'sign')::integer, 1);

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_resolved_value := v_roll_total * v_dice_sign;
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, resolved_value, parent_cast_id, reaction_window_id, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_participant.player_id, false,
          v_effect.effect_kind, v_effect.effect_params, v_resolved_value, p_target_cast_id, v_window_id, v_effect.target_role
        )
        returning id into v_row_cast_id;

        if v_cast_id is null then
          v_cast_id := v_row_cast_id;
        end if;
      end loop;

      continue;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS') then
      v_row_target := null;
    else
      v_row_target := case when v_effect.target_role = 'CASTER' then v_player_id else v_final_target end;
    end if;

    -- dice_modifier (CASTER/TARGET role, e.g. Slipped Spoon's 1d4) is left
    -- resolved_value = null here (issue #252) — resolved afterward via
    -- resolve_pending_spell_die_in_app/_manual below.
    v_resolved_value := null;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, resolved_value, parent_cast_id, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, false,
      v_effect.effect_kind, v_effect.effect_params, v_resolved_value, p_target_cast_id, v_window_id, v_effect.target_role
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_effect.effect_kind = 'contested_negate' then
      v_dc := case v_target_tier when 'common' then 2 when 'rare' then 5 else 10 end;
      v_roll := floor(random() * 20 + 1)::integer;

      update public.spell_casts set resolved_value = v_roll where id = v_row_cast_id;

      if v_roll >= v_dc then
        update public.spell_casts set negated = true where id = p_target_cast_id;
      end if;
    elsif v_effect.effect_kind = 'redirect' then
      update public.spell_casts set resolved_value = 1 where id = v_row_cast_id;

      if v_target_target_player is not null then
        update public.spell_casts set target_player_id = v_player_id where id = p_target_cast_id;
      end if;
    end if;
  end loop;

  update public.spell_reaction_windows
     set poll_round = poll_round + 1
   where id = v_window_id;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_reaction_spell_card(uuid, text, uuid) from public, anon;
grant execute on function public.cast_reaction_spell_card(uuid, text, uuid) to authenticated;

-- get_current_layer_rolls_if_complete (latest prior definition: 0051) and
-- its stall-timeout counterpart get_completed_layer_rolls_for_stall_resolution
-- (same file) both gain the same extra gate: layer 0 isn't "complete" while
-- any dice_modifier spell cast for this round is still awaiting its player
-- (resolved_value is null) — resolving the layer with that effect silently
-- worth 0 would be wrong, not just incomplete. Scoped to layer 0 only, since
-- spell effects never reach a tie-break reroll layer (Layer's own glossary
-- entry, CONTEXT.md). No new stall-timeout is added for this (issue #252's
-- explicit scope) — a pending pre-roll cast (Cold Tea) simply waits for its
-- caster with no expiry, same as a Pending Spell Draw; a pending reaction
-- cast (Slipped Spoon) rides the existing reaction-window machinery once
-- resolved (see resolve_pending_spell_die_in_app/_manual below and
-- src/app/rounds/actions.ts's afterPendingSpellDieResolved).
create or replace function public.get_current_layer_rolls_if_complete(p_round_id uuid)
returns table (layer integer, player_id text, value integer, modifier_snapshot integer, discarded_value integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_layer integer;
  v_expected_count integer;
  v_roll_count integer;
begin
  v_player_id := public.current_player_id(p_round_id);

  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_current_layer_rolls_if_complete: round not found';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'get_current_layer_rolls_if_complete: caller is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  v_expected_count := public.count_expected_layer_rollers(p_round_id, v_layer);

  select count(*) into v_roll_count
    from public.rolls r
   where r.round_id = p_round_id and r.layer = v_layer;

  if v_roll_count < v_expected_count then
    return;
  end if;

  if v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and effect_kind = 'dice_modifier' and resolved_value is null
  ) then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot, r.discarded_value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_current_layer_rolls_if_complete(uuid) from public, anon;
grant execute on function public.get_current_layer_rolls_if_complete(uuid) to authenticated;

create or replace function public.get_completed_layer_rolls_for_stall_resolution(p_round_id uuid)
returns table (layer integer, player_id text, value integer, modifier_snapshot integer, discarded_value integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_layer integer;
  v_expected_count integer;
  v_roll_count integer;
begin
  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_completed_layer_rolls_for_stall_resolution: round not found';
  end if;

  v_expected_count := public.count_expected_layer_rollers(p_round_id, v_layer);

  select count(*) into v_roll_count
    from public.rolls r
   where r.round_id = p_round_id and r.layer = v_layer;

  if v_roll_count < v_expected_count then
    return;
  end if;

  if v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and effect_kind = 'dice_modifier' and resolved_value is null
  ) then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot, r.discarded_value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) from public, anon;
grant execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) to authenticated;

-- get_my_pending_spell_dice: the caller's own dice_modifier casts still
-- awaiting a value for this round (issue #252) — drives
-- PendingSpellDiePanel.tsx the same way get_my_pending_casts drives
-- TargetConfirmForm for a deferred OPPONENT/PLAYER target. Round-scoped
-- (not a global "oldest outstanding" lookup like get_my_pending_spell_draw)
-- since a pending die must resolve before *this* round can finalize — it
-- can't accumulate across rounds the way a Pending Spell Draw can.
create function public.get_my_pending_spell_dice(p_round_id uuid)
returns table (cast_id uuid, card_name text, dice text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select casts.id, sc.name, casts.effect_params ->> 'dice'
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where casts.round_id = p_round_id
       and casts.target_player_id = v_player_id
       and casts.effect_kind = 'dice_modifier'
       and casts.resolved_value is null
     order by casts.cast_at asc;
end;
$$;

revoke execute on function public.get_my_pending_spell_dice(uuid) from public, anon;
grant execute on function public.get_my_pending_spell_dice(uuid) to authenticated;

-- resolve_pending_spell_die_in_app/_manual: the two RPCs that finally give a
-- dice_modifier effect its value (issue #252), mirroring submit_roll/
-- submit_manual_roll's own in-app/manual split for the main d20 roll. Only
-- the cast's own target_player_id (the affected player — the caster, for
-- every dice_modifier card in the catalog today; see header comment) may
-- resolve it. Applies the same sign multiplier cast_spell_card's old inline
-- random() path always has.
create function public.resolve_pending_spell_die_in_app(p_cast_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_row public.spell_casts%rowtype;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
begin
  select * into v_row from public.spell_casts where id = p_cast_id for update;

  if not found then
    raise exception 'resolve_pending_spell_die_in_app: cast not found';
  end if;

  v_player_id := public.current_player_id();

  if v_row.target_player_id <> v_player_id then
    raise exception 'resolve_pending_spell_die_in_app: only the affected player can resolve this die';
  end if;

  if v_row.effect_kind <> 'dice_modifier' or v_row.resolved_value is not null then
    raise exception 'resolve_pending_spell_die_in_app: this cast has no pending die to resolve';
  end if;

  v_dice_count := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
  v_dice_sides := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
  v_dice_sign := coalesce((v_row.effect_params ->> 'sign')::integer, 1);

  v_roll_total := 0;
  for i in 1..v_dice_count loop
    v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
  end loop;

  update public.spell_casts set resolved_value = v_roll_total * v_dice_sign where id = p_cast_id;

  return v_roll_total;
end;
$$;

revoke execute on function public.resolve_pending_spell_die_in_app(uuid) from public, anon;
grant execute on function public.resolve_pending_spell_die_in_app(uuid) to authenticated;

create function public.resolve_pending_spell_die_manual(p_cast_id uuid, p_value integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_row public.spell_casts%rowtype;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
begin
  select * into v_row from public.spell_casts where id = p_cast_id for update;

  if not found then
    raise exception 'resolve_pending_spell_die_manual: cast not found';
  end if;

  v_player_id := public.current_player_id();

  if v_row.target_player_id <> v_player_id then
    raise exception 'resolve_pending_spell_die_manual: only the affected player can resolve this die';
  end if;

  if v_row.effect_kind <> 'dice_modifier' or v_row.resolved_value is not null then
    raise exception 'resolve_pending_spell_die_manual: this cast has no pending die to resolve';
  end if;

  v_dice_count := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
  v_dice_sides := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
  v_dice_sign := coalesce((v_row.effect_params ->> 'sign')::integer, 1);

  if p_value is null or p_value < v_dice_count or p_value > v_dice_count * v_dice_sides then
    raise exception 'resolve_pending_spell_die_manual: value must be between % and %', v_dice_count, v_dice_count * v_dice_sides;
  end if;

  update public.spell_casts set resolved_value = p_value * v_dice_sign where id = p_cast_id;
end;
$$;

revoke execute on function public.resolve_pending_spell_die_manual(uuid, integer) from public, anon;
grant execute on function public.resolve_pending_spell_die_manual(uuid, integer) to authenticated;

-- round_layer_zero_reaction_window_exists: tells
-- afterPendingSpellDieResolved (src/app/rounds/actions.ts) whether a layer-0
-- reaction window already exists for this round (open, or closed but
-- blocked from finalizing by the gate above) — if so, resolving the last
-- pending die should call finalizeReactionWindow directly rather than
-- resolveCompletedLayerIfAny, which would try to open a *second* window and
-- collide with spell_reaction_windows_one_open_per_round (0021) if the
-- existing one is still open, or simply never reopen reactions for this
-- layer if it's already closed.
create function public.round_layer_zero_reaction_window_exists(p_round_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.spell_reaction_windows
     where round_id = p_round_id and layer = 0
  );
$$;

revoke execute on function public.round_layer_zero_reaction_window_exists(uuid) from public, anon;
grant execute on function public.round_layer_zero_reaction_window_exists(uuid) to authenticated;
