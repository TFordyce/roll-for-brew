-- Durable persistent-modifier cards: Chai-nge of Heart, Tea-tally Spent,
-- Bitter Leech (issue #342, child of spec #302 / ADR 0005).
--
-- A follow-up slice of the effect-application rebuild, landing on the shared
-- integration branch rebuild/effect-resolver after #311 (migration 0085)
-- gave room_players.modifier its log-derived cache and the
-- persistent_modifier_transfer / persistent_modifier_spend projection.
-- Siblings #343 (round-scoped snapshot cards) and #344 (ward interaction) are
-- NOT in scope here.
--
--   * Chai-nge of Heart (Action, OPPONENT): cast-time bespoke emission in
--     cast_spell_card -- a sibling persistent_modifier_transfer pair that
--     swaps the caster's and target's effective modifiers rest-of-day, with
--     a {caster_modifier, target_modifier} cast_inputs snapshot. Whole-cast
--     negation drops both rows; resolve_round Phase 4b (negated rows kept in
--     the target gather) reverts both caches on re-resolution.
--
--   * Tea-tally Spent (Reaction, SELF): cast_reaction_spell_card gains a
--     p_spend_amount arg (=> signature change, DROP + CREATE). Clamps the
--     spend to [0, current effective modifier]; RFB44 when the caster has
--     nothing to spend, RFB45 when the amount is omitted. Emits a durable
--     persistent_modifier_spend {delta:-n} on SELF plus a round-scoped
--     flat_modifier {delta:+n} on SELF for this round's roll only.
--
--   * Bitter Leech (Action, OPPONENT): duration_rounds = 3 + a single
--     persistent_modifier_transfer active effect ({per_round_delta:1,
--     direction:caster_gains}). resolve_round Phase 4b-pre synthesises a
--     -1 / +1 transfer pair into the Cast Log each round the effect is live
--     (cast round + next 2), so the existing Phase 4b projection and
--     get_modifier_breakdown reconciliation carry it with no new maths.
--     rebuild_active_effects_projection skips those synthetic tick rows.
--
-- All three cards are un-benched (spell_deck_instances.location 'benched' ->
-- 'in_deck'). New error codes: RFB44, RFB45, RFB46.
--
-- Migration numbering: master's highest is 0077; rebuild/effect-resolver runs
-- 0078-0087 (0086 = get_round_recap, PR #346; 0087 = round-scoped snapshot
-- cards, PR #347 / #343, MERGED). This is 0088. #343 re-emitted
-- cast_spell_card, so this migration slices its cast_spell_card body from
-- 0087, not 0085, to preserve the Bes-Tea / Tea Leaf / Spillage special-case.
-- Re-check the number at the #303 integrate step.

-- ---------------------------------------------------------------------------
-- 1. Un-bench the three cards (migration 0074 parked them at 'benched').
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name in ('Chai-nge of Heart', 'Tea-tally Spent', 'Bitter Leech')
   and sdi.location = 'benched';

-- ---------------------------------------------------------------------------
-- 2. Bitter Leech is a 3-round effect -- record_active_effect_if_persistent
--    reads duration_rounds to stamp rounds_remaining on the projection row.
-- ---------------------------------------------------------------------------
update public.spell_cards set duration_rounds = 3 where name = 'Bitter Leech';

-- ---------------------------------------------------------------------------
-- 3. cast_spell_card -- re-emitted from 0085 with a name-based special-case
--    for Chai-nge of Heart and Bitter Leech ahead of the WILD block.
-- ---------------------------------------------------------------------------
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
  v_card_name text;
  v_casting_time text;
  v_target_stamp text;
  v_target_pending boolean := false;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_pending boolean;
  v_row_cast_id uuid;
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_effect_params jsonb;
  v_max_targets integer;
  v_chosen_id text;
  v_branch integer;
  v_other_id text;
  v_extreme_low text;
  v_extreme_high text;
  v_target_mod integer;
  v_snap integer;
  v_caster_mod integer;
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

  select sdi.id, sc.id, sc.name, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_card_name, v_casting_time, v_target_stamp
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

  -- issue #343: round-scoped modifier snapshot cards. Fully special-cased
  -- (like WILD / Kettle Crash / declared_number_tea_maker) because the
  -- generic per-effect loop can only copy static spell_card_effects params
  -- and these cards need a value computed from live modifiers at cast time.
  -- The rows emitted here carry no duration and no spell_active_effects
  -- row, so resolve_round Phase 4a composes them for THIS round only and
  -- they revert automatically at round end.
  if v_card_name in ('Bes-Tea', 'Tea Leaf', 'Spillage') then
    if v_final_target is null then
      raise exception 'cast_spell_card: this card requires a target chosen at cast time';
    end if;

    select coalesce(modifier, 0) into v_target_mod
      from public.room_players
     where room_id = v_room_id and player_id = v_final_target;
    v_target_mod := coalesce(v_target_mod, 0);

    if v_card_name = 'Bes-Tea' then
      -- Copy the target's effective modifier onto the caster for this round.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'set_modifier', jsonb_build_object('value', v_target_mod),
        jsonb_build_object('source_modifier', v_target_mod), 'CASTER'
      )
      returning id into v_cast_id;

    elsif v_card_name = 'Tea Leaf' then
      -- Target's modifier drops to 0 for this round...
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'set_modifier', jsonb_build_object('value', 0),
        jsonb_build_object('stolen_amount', v_target_mod), 'TARGET'
      )
      returning id into v_cast_id;

      -- ...and the stolen amount is added to the caster's roll this round.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'flat_modifier', jsonb_build_object('delta', v_target_mod),
        jsonb_build_object('stolen_amount', v_target_mod), 'CASTER'
      );

    else
      -- Spillage: floor(m/2) leaves the target and joins the caster's roll
      -- for this round. Postgres integer division truncates toward zero, so
      -- compute the floor explicitly for negative modifiers.
      v_snap := floor(v_target_mod / 2.0)::integer;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'flat_modifier', jsonb_build_object('delta', -v_snap),
        jsonb_build_object('stolen_amount', v_snap), 'TARGET'
      )
      returning id into v_cast_id;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'flat_modifier', jsonb_build_object('delta', v_snap),
        jsonb_build_object('stolen_amount', v_snap), 'CASTER'
      );
    end if;

    return v_cast_id;
  end if;

  -- issue #342: two durable persistent-modifier cards whose emission the
  -- generic spell_card_effects loop cannot express (they carry no effect
  -- rows). Both are Action / OPPONENT and need an explicit target at cast
  -- time (RFB46) -- no deferred-target path in this slice. v_card_name is
  -- already populated from the held-card lookup above (#343).
  if v_card_name = 'Chai-nge of Heart' then
    if v_final_target is null then
      raise exception 'cast_spell_card: Chai-nge of Heart requires an explicit target'
        using errcode = 'RFB46';
    end if;

    select modifier into v_caster_mod from public.room_players
     where room_id = v_room_id and player_id = v_player_id;
    select modifier into v_target_mod from public.room_players
     where room_id = v_room_id and player_id = v_final_target;
    v_caster_mod := coalesce(v_caster_mod, 0);
    v_target_mod := coalesce(v_target_mod, 0);

    -- Sibling persistent_modifier_transfer pair: caster gains (target - caster),
    -- target gains (caster - target) -> their effective modifiers swap for the
    -- rest of the day. resolve_round Phase 4b projects both into
    -- room_players.modifier; whole-cast negation (shared card_instance_id)
    -- drops both. cast_inputs snapshots both effective modifiers at cast time.
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id,
      'persistent_modifier_transfer',
      jsonb_build_object('delta', v_target_mod - v_caster_mod),
      jsonb_build_object('caster_modifier', v_caster_mod, 'target_modifier', v_target_mod)
    )
    returning id into v_cast_id;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target,
      'persistent_modifier_transfer',
      jsonb_build_object('delta', v_caster_mod - v_target_mod),
      jsonb_build_object('caster_modifier', v_caster_mod, 'target_modifier', v_target_mod),
      v_cast_id
    );

    return v_cast_id;

  elsif v_card_name = 'Bitter Leech' then
    if v_final_target is null then
      raise exception 'cast_spell_card: Bitter Leech requires an explicit target'
        using errcode = 'RFB46';
    end if;

    -- One anchor cast + one spell_active_effects row (rounds_remaining => 3
    -- from the card's duration_rounds). resolve_round Phase 4b-pre projects a
    -- -1 / +1 persistent_modifier_transfer pair off it every round it is live
    -- (cast round + next 2). The anchor carries no 'delta' key, so it never
    -- contributes to _rr_spell_modifier_delta on its own.
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target,
      'persistent_modifier_transfer',
      jsonb_build_object('per_round_delta', 1, 'direction', 'caster_gains'),
      '{}'::jsonb
    )
    returning id into v_cast_id;

    perform public.record_active_effect_if_persistent(
      v_room_id, v_player_id, v_final_target, v_card_id,
      'persistent_modifier_transfer',
      jsonb_build_object('per_round_delta', 1, 'direction', 'caster_gains'),
      v_cast_id
    );

    return v_cast_id;
  end if;

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
      -- issue #311: +3 caster rest of day -> a one-sided
      -- persistent_modifier_transfer the resolver's Phase 4b projects into
      -- room_players.modifier at resolve. No imperative write here.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id,
        effect_kind, effect_params, cast_inputs
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id,
        'persistent_modifier_transfer', jsonb_build_object('delta', 3), '{}'::jsonb
      );
      v_effect_params := '{"delta": 3}'::jsonb;
    elsif v_branch = 3 then
      select player_id into v_other_id
        from public.room_players
       where room_id = v_room_id and player_id <> v_player_id
       order by random()
       limit 1;
      if v_other_id is not null then
        -- issue #311: modifier swap -> a persistent_modifier_transfer sibling
        -- pair with a cast-time snapshot; the resolver's Phase 4b projects
        -- both sides. swap_room_player_modifiers is retired.
        perform public._rr_emit_modifier_swap_pair(
          v_room_id, p_round_id, v_player_id, v_instance_id, v_player_id, v_other_id
        );
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
        -- issue #311: highest <-> lowest modifier swap -> a
        -- persistent_modifier_transfer sibling pair with a cast-time snapshot.
        perform public._rr_emit_modifier_swap_pair(
          v_room_id, p_round_id, v_player_id, v_instance_id, v_extreme_high, v_extreme_low
        );
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
        round_id, caster_id, card_instance_id, target_player_id,
        effect_kind, effect_params, cast_inputs
      )
      values (p_round_id, v_player_id, v_instance_id, null,
              'wild_dispatch', '{"branch": 6}'::jsonb, jsonb_build_object('branch', v_branch));

      return v_cast_id;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs
    )
    values (p_round_id, v_player_id, v_instance_id, null,
            'wild_dispatch', v_effect_params, jsonb_build_object('branch', v_branch))
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

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, target_role
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_effect.effect_kind, v_effect_params, v_effect.target_role)
      returning id into v_row_cast_id;

      -- #310: Cast Log row first so the sentinel active-effect row can carry a
      -- real source_cast_id (spell_active_effects.source_cast_id is NOT NULL).
      -- rounds_remaining => 1: the declared number applies to its own cast
      -- round only, then _rr_active_effects_as_of derives it expired -- no
      -- physical DELETE (resolve_declared_number_tea_maker, #310).
      insert into public.spell_active_effects (
        room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining
      )
      values (v_room_id, v_player_id, v_player_id, v_row_cast_id, v_card_id, v_effect.effect_kind, v_effect_params, 1);

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
      if v_effect.effect_kind = 'reset_persistent_modifier' then
        -- Kettle Crash (#285, migration 0076): persistent, not round-scoped,
        -- so apply the reset live at cast time — no close_round fan-out. The
        -- spell_casts insert just below is the audit trail.
        update public.room_players set modifier = 0 where room_id = v_room_id;
      end if;

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
        -- #312: a CHOSEN_PLAYERS dice_modifier rolls immediately at cast time
        -- (unlike a CASTER/TARGET one, which defers to a Pending Spell Die).
        -- The raw, unsigned total is recorded into cast_inputs.dice_roll;
        -- its presence keeps this cast out of get_my_pending_spell_dice --
        -- the role a non-null resolved_value used to play.
        v_cast_inputs := null;

        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_cast_inputs := jsonb_build_object('dice_roll', v_roll_total);
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, cast_inputs, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_chosen_id, false,
          v_effect.effect_kind, v_effect_params, v_cast_inputs, v_effect.target_role
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

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, v_row_pending,
      v_effect.effect_kind, v_effect_params, v_effect.target_role
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

-- ---------------------------------------------------------------------------
-- 4. cast_reaction_spell_card -- re-emitted from 0083, signature widened
--    with p_spend_amount, name-based special-case for Tea-tally Spent.
-- ---------------------------------------------------------------------------
drop function if exists public.cast_reaction_spell_card(uuid, text, uuid);

create or replace function public.cast_reaction_spell_card(
  p_round_id uuid, p_target_player_id text default null, p_target_cast_id uuid default null,
  p_spend_amount integer default null
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
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_target_tier text;
  v_target_target_player text;
  v_target_group uuid;
  v_dc integer;
  v_roll integer;
  v_participant record;
  v_room_id uuid;
  v_card_name text;
  v_eff_mod integer;
  v_spend integer;
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
    select casts.target_player_id, casts.card_instance_id, sc2.tier
      into v_target_target_player, v_target_group, v_target_tier
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

  select room_id into v_room_id from public.rounds where id = p_round_id;
  select name into v_card_name from public.spell_cards where id = v_card_id;

  -- issue #342: Tea-tally Spent. Spend a clamped amount of your own effective
  -- modifier durably (a persistent_modifier_spend {delta:-n} on SELF, picked
  -- up by resolve_round Phase 4b and _rr_spell_modifier_delta) and add the
  -- same amount to THIS round's roll only (a round-scoped flat_modifier
  -- {delta:+n} on SELF, composed by Phase 4a). No spell_card_effects rows.
  if v_card_name = 'Tea-tally Spent' then
    if p_spend_amount is null then
      raise exception 'cast_reaction_spell_card: Tea-tally Spent requires a spend amount'
        using errcode = 'RFB45';
    end if;

    select modifier into v_eff_mod from public.room_players
     where room_id = v_room_id and player_id = v_player_id;
    v_eff_mod := coalesce(v_eff_mod, 0);

    if v_eff_mod <= 0 then
      raise exception 'cast_reaction_spell_card: caster has no modifier to spend'
        using errcode = 'RFB44';
    end if;

    v_spend := least(greatest(p_spend_amount, 0), v_eff_mod);

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id, false,
      'persistent_modifier_spend', jsonb_build_object('delta', -v_spend),
      jsonb_build_object('spend_amount', v_spend), v_window_id, 'CASTER'
    )
    returning id into v_cast_id;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role, source_cast_id
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id, false,
      'flat_modifier', jsonb_build_object('delta', v_spend),
      jsonb_build_object('spend_amount', v_spend), v_window_id, 'CASTER', v_cast_id
    );

    update public.spell_reaction_windows
       set poll_round = poll_round + 1
     where id = v_window_id;

    return v_cast_id;
  end if;

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
        -- #312: a table-wide reaction dice_modifier rolls now, into
        -- cast_inputs.dice_roll (raw, unsigned). resolve_round / the finalize
        -- shim apply the sign.
        v_cast_inputs := null;

        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_cast_inputs := jsonb_build_object('dice_roll', v_roll_total);
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_participant.player_id, false,
          v_effect.effect_kind, v_effect.effect_params, v_cast_inputs, p_target_cast_id, v_window_id, v_effect.target_role
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

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, parent_cast_id, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, false,
      v_effect.effect_kind, v_effect.effect_params, p_target_cast_id, v_window_id, v_effect.target_role
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_effect.effect_kind = 'contested_negate' then
      -- effect_params.dc (from the card's spell_card_effects row) overrides
      -- the tier default: Saving Steep {"dc": 10}, Tannin Tantrum omits it.
      v_dc := coalesce(
        (v_effect.effect_params ->> 'dc')::integer,
        public._rr_tier_default_dc(v_target_tier));
      v_roll := floor(random() * 20 + 1)::integer;

      -- The d20 is a server-RNG draw -> record it into the Cast Log
      -- (cast_inputs.dc_d20) alongside the DC it was checked against.
      update public.spell_casts
         set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                           || jsonb_build_object('dc_d20', v_roll, 'dc', v_dc)
       where id = v_row_cast_id;

      -- PROVISIONAL cache for live readers only (reaction stack, the
      -- finalize shim's negated filter, the get_round_modifier_effects
      -- preview). resolve_round Phase 1 recomputes negation recursively
      -- (counter-of-counter to any depth) and overwrites this
      -- authoritatively — for a single-level counter the two always agree.
      if v_roll >= v_dc then
        update public.spell_casts set negated = true where id = p_target_cast_id;
      end if;

      -- Natural 1 on a counter whose card carries the backfire behaviour
      -- (effect_params.backfire = true -- Saving Steep only; Tannin Tantrum
      -- omits it and just "resolves as normal" on a fail, spec §8). It does
      -- NOT negate the victim; instead resolve_round re-applies every effect
      -- row of the victim group once more onto the reactor. Draw + record
      -- every extra server-RNG that needs, now, into cast_inputs.backfire --
      -- whose presence is then the resolver's backfire signal.
      if v_roll = 1
         and v_target_group is not null
         and coalesce((v_effect.effect_params ->> 'backfire')::boolean, false) then
        perform public._rr_record_backfire(v_row_cast_id, v_target_group);
      end if;
    elsif v_effect.effect_kind = 'redirect' then
      -- #312: redirect records nothing of its own (spec §4: cast_inputs = {}).
      update public.spell_casts
         set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
       where id = v_row_cast_id;

      -- No in-place target_player_id UPDATE (spec §8). Provisional
      -- redirected_to_cast_id pointer only; resolve_round Phase 1 derives
      -- the effective post-redirect target from recorded state.
      if v_target_group is not null then
        update public.spell_casts
           set redirected_to_cast_id = v_row_cast_id
         where id = p_target_cast_id;
      end if;
    end if;
  end loop;

  update public.spell_reaction_windows
     set poll_round = poll_round + 1
   where id = v_window_id;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_reaction_spell_card(uuid, text, uuid, integer) from public, anon;
grant execute on function public.cast_reaction_spell_card(uuid, text, uuid, integer) to authenticated;

comment on function public.cast_reaction_spell_card(uuid, text, uuid, integer) is
  'Reaction-window cast (issues up to #342). p_spend_amount is Tea-tally '
  'Spent only: the modifier the caster burns, clamped to [0, current '
  'effective modifier]; RFB45 when omitted for that card, RFB44 when the '
  'caster has no modifier to spend.';

-- ---------------------------------------------------------------------------
-- 5. resolve_round(uuid) -- re-emitted from 0085 with Phase 4b-pre (Bitter
--    Leech tick synthesis) and the Phase 4b target gather / running-sum
--    tweaks for negated Chai-nge reverts and delta-less anchor rows.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_participant_count integer;
  v_roll_count integer;
  v_expected_layer_count integer;

  v_trace jsonb := '[]'::jsonb;
  v_step_index integer := 0;

  v_brewer_id text := null;
  v_brewer_source text := 'default';
  v_no_modifier_gain boolean := false;
  v_tied text[];

  -- per-player working state, parallel arrays indexed 1..n
  v_players text[] := array[]::text[];
  v_rolls integer[] := array[]::integer[];
  v_base numeric[] := array[]::numeric[];
  v_composed numeric[] := array[]::numeric[];
  v_snapshots numeric[] := array[]::numeric[];
  v_effects_json jsonb := '{}'::jsonb;   -- { player_id: [ normalised effect, ... ] }

  -- Phase 1 (Cast-Log resolution) working state
  v_has_counters boolean := false;
  v_negated_groups uuid[] := array[]::uuid[];
  v_redirect_map jsonb := '{}'::jsonb;   -- { card_instance_id::text: new_target_player_id }
  v_clr record;
  v_victim record;
  v_bf record;
  v_t jsonb;

  -- Phase 2 (ward projection) working state (issue #309)
  v_ward_map jsonb := '{}'::jsonb;   -- { player_id: [ { domain, polarity, block_earned_modifier, ward_seq, ward_cast_id, ward_card_name }, ... ] }
  v_ward_hit jsonb;
  v_ward_pol text;
  v_ward_idx integer;
  v_wb_before numeric;
  v_wb_after numeric;
  v_lghm_seq bigint;

  v_row record;
  v_el jsonb;
  v_pid text;
  v_i integer;
  v_local_idx integer;
  v_before numeric;
  v_after numeric;
  v_running numeric;
  v_eff_target text;

  v_has_lghm boolean := false;
  v_lghm_cast record;
  v_high_roll_composed numeric;
  v_lowest_roll integer;

  v_override record;
  v_declared record;

  -- Phase 4b (issue #311) working state
  v_pm_targets text[] := array[]::text[];
  v_pm_running numeric;
  v_pm_row record;

  -- Phase 4b-pre (issue #342) working state
  v_gen integer;
  v_bl record;
begin
  select status, room_id, current_layer, replay_generation
    into v_status, v_room_id, v_layer, v_gen
    from public.rounds
   where id = p_round_id
     for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
  end if;

  select count(*) into v_participant_count
    from public.round_participants
   where round_id = p_round_id;

  v_expected_layer_count := public.count_expected_layer_rollers(p_round_id, v_layer);
  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = v_layer;

  if v_roll_count < v_expected_layer_count then
    raise exception 'resolve_round: not all participants have rolled yet';
  end if;

  -- ======================================================================
  -- Tie-break reroll layers (layer > 0): no spell logic at all (issue #219).
  -- ======================================================================
  if v_layer > 0 then
    for v_row in
      select r.player_id, r.value, r.modifier_snapshot
        from public.rolls r
       where r.round_id = p_round_id and r.layer = v_layer
       order by r.player_id
    loop
      v_players := v_players || v_row.player_id;
      v_rolls := v_rolls || v_row.value;
      v_snapshots := v_snapshots || v_row.modifier_snapshot::numeric;
    end loop;

    v_tied := public._rr_pick_lowest(v_players, v_rolls, v_snapshots);

    if array_length(v_tied, 1) = 1 then
      return jsonb_build_object(
        'outcome', 'brewer', 'layer', v_layer,
        'brewer_id', v_tied[1], 'brewer_source', 'default',
        'tied_player_ids', null,
        'cups_made', v_participant_count, 'no_modifier_gain', false,
        'trace', '[]'::jsonb
      );
    end if;

    return jsonb_build_object(
      'outcome', 'tie', 'layer', v_layer,
      'brewer_id', null, 'brewer_source', null,
      'tied_player_ids', to_jsonb(v_tied),
      'cups_made', v_participant_count, 'no_modifier_gain', false,
      'trace', '[]'::jsonb
    );
  end if;

  -- ======================================================================
  -- Layer 0.
  -- ======================================================================

  -- Load this layer's rollers into the parallel working arrays.
  for v_row in
    select r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = 0
     order by r.player_id
  loop
    v_players := v_players || v_row.player_id;
    v_rolls := v_rolls || v_row.value;
    v_base := v_base || v_row.modifier_snapshot::numeric;
    v_composed := v_composed || v_row.modifier_snapshot::numeric;
    v_snapshots := v_snapshots || v_row.modifier_snapshot::numeric;
    v_effects_json := jsonb_set(v_effects_json, array[v_row.player_id], '[]'::jsonb, true);
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 1: Cast-Log resolution (issue #307/#308).
  -- ------------------------------------------------------------------
  select exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind in ('contested_negate', 'redirect')
  ) into v_has_counters;

  if v_has_counters then
    v_negated_groups := array[]::uuid[];
    v_redirect_map := '{}'::jsonb;

    drop table if exists _rr_clr_rows;
    create temp table _rr_clr_rows on commit drop as
      select * from public._rr_cast_log_resolution(p_round_id);

    for v_clr in
      select * from _rr_clr_rows
    loop
      if v_clr.counter_kind = 'contested_negate'
         and v_clr.counter_succeeded
         and not v_clr.counter_negated then
        if not (v_clr.victim_group = any (v_negated_groups)) then
          v_negated_groups := v_negated_groups || v_clr.victim_group;
        end if;
      end if;

      if v_clr.redirect_to is not null then
        v_redirect_map := jsonb_set(
          v_redirect_map,
          array[v_clr.victim_cast_id::text],
          to_jsonb(v_clr.redirect_to),
          true
        );
      end if;
    end loop;

    update public.spell_casts
       set negated = (card_instance_id = any (v_negated_groups))
     where round_id = p_round_id;

    update public.spell_casts
       set redirected_to_cast_id = null
     where round_id = p_round_id and redirected_to_cast_id is not null;

    for v_clr in
      select * from _rr_clr_rows
     where redirect_to is not null
    loop
      if not (v_clr.victim_group = any (v_negated_groups)) then
        update public.spell_casts
           set redirected_to_cast_id = v_clr.counter_cast_id
         where id = v_clr.victim_cast_id;
      end if;
    end loop;

    for v_clr in
      select clr.*, sc.name as counter_card_name
        from _rr_clr_rows clr
        join public.spell_casts c on c.id = clr.counter_cast_id
        join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
       order by clr.counter_seq
    loop
      if v_clr.counter_kind = 'contested_negate' then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'contested_negate',
          jsonb_build_object(
            'cast_id', to_jsonb(v_clr.counter_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_clr.counter_card_name),
            'caster_player_id', to_jsonb(v_clr.counter_caster)
          ),
          v_clr.victim_orig_target,
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value',
            case
              when v_clr.counter_negated then 'countered'
              when v_clr.counter_backfired then 'backfired'
              when v_clr.counter_succeeded then 'negated target'
              else 'no effect'
            end),
          jsonb_build_object(
            'dc_d20', v_clr.counter_dc_d20,
            'dc', v_clr.counter_dc,
            'outcome', case
              when v_clr.counter_backfired then 'backfired'
              when not v_clr.counter_negated and v_clr.counter_succeeded then 'applied'
              else 'no-op'
            end)
        ));
        v_step_index := v_step_index + 1;
      else
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'redirect',
          jsonb_build_object(
            'cast_id', to_jsonb(v_clr.counter_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_clr.counter_card_name),
            'caster_player_id', to_jsonb(v_clr.counter_caster)
          ),
          v_clr.redirect_to,
          jsonb_build_object('type', 'target', 'value', v_clr.victim_orig_target),
          jsonb_build_object('type', 'target', 'value',
            case when v_clr.counter_negated then v_clr.victim_orig_target else v_clr.redirect_to end)
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;

    for v_victim in
      select distinct on (c.card_instance_id)
             c.card_instance_id as group_id,
             c.effect_kind,
             c.target_player_id,
             c.caster_id,
             sc.name as card_name
        from public.spell_casts c
        join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
       where c.round_id = p_round_id
         and c.card_instance_id = any (v_negated_groups)
       order by c.card_instance_id, c.seq
    loop
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        coalesce(v_victim.effect_kind, 'unknown'),
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', null,
          'card_name', to_jsonb(v_victim.card_name),
          'caster_player_id', to_jsonb(v_victim.caster_id)
        ),
        v_victim.target_player_id,
        jsonb_build_object('type', 'status', 'value', 'negated'),
        jsonb_build_object('type', 'status', 'value', 'negated'),
        jsonb_build_object('negated', true)
      ));
      v_step_index := v_step_index + 1;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 2: ward projection (issue #309).
  --
  -- Load every active ward (spell_active_effects.effect_kind = 'ward')
  -- targeting a layer-0 roller into v_ward_map, keyed by target player, each
  -- carrying its source cast seq (ward_seq -- NULL when projected from a
  -- prior round or seeded). Modifier-domain wards filter Phase 4a / 4c below;
  -- block_earned_modifier suppresses the brewer's tea gain in Phase 5.
  -- Roll-domain wards were already applied as a pre-check in the eager shim
  -- and arrive as `warded` markers on cast_inputs.roll_transform that Phase 3
  -- turns into steps.
  -- ------------------------------------------------------------------
  select coalesce(jsonb_object_agg(t.pid, t.wards), '{}'::jsonb)
    into v_ward_map
    from (
      select sae.target_player_id as pid,
             jsonb_agg(jsonb_build_object(
               'domain', sae.effect_params -> 'domain',
               'polarity', sae.effect_params -> 'polarity',
               'block_earned_modifier', coalesce((sae.effect_params ->> 'block_earned_modifier')::boolean, false),
               -- #310: a ward whose source cast is in an EARLIER round always
               -- counts as earlier-seq than any effect cast this round
               -- (_rr_ward_hit treats a NULL ward_seq as "before every
               -- effect"); only a ward cast in THIS round keeps its real seq,
               -- for correct same-round ordering. This is the same rule
               -- _rr_active_ward_gate already applies via its
               -- `wc.round_id <> p_round_id` short-circuit -- Phase 2 just
               -- reads its own map so it has to encode it here. Behaviour is
               -- unchanged for real rounds: a prior-round ward's seq was
               -- already strictly below every current-round effect seq, and a
               -- carried-forward effect passes ord = NULL regardless.
               'ward_seq', case when wc.round_id = p_round_id then wc.seq else null end,
               'ward_cast_id', sae.source_cast_id,
               'ward_card_name', scw.name
             ) order by sae.created_at) as wards
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
        join public.spell_cards scw on scw.id = sae.card_id
        left join public.spell_casts wc on wc.id = sae.source_cast_id
       where sae.room_id = v_room_id
         and sae.effect_kind = 'ward'
         and sae.target_player_id = any (v_players)
       group by sae.target_player_id
    ) t;

  -- ------------------------------------------------------------------
  -- Phase 3: roll-input accounting (issue #306/#308/#309).
  -- ------------------------------------------------------------------
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_running := null;

    for v_row in
      select casts.id as cast_id,
             casts.seq as seq,
             casts.caster_id as caster_id,
             casts.effect_kind as kind,
             casts.negated as is_negated,
             sc.name as card_name,
             (rt.rt ->> 'order')::integer as ord,
             (pe.value ->> 'before')::numeric as p_before,
             (pe.value ->> 'after')::numeric as p_after,
             coalesce((pe.value -> 'warded')::text = 'true', false) as is_warded,
             (pe.value ->> 'would_be_after')::numeric as would_be_after,
             pe.value ->> 'ward_cast_id' as ward_cast_id,
             pe.value ->> 'ward_card_name' as ward_card_name
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
        cross join lateral (select casts.cast_inputs -> 'roll_transform' as rt) rt
        cross join lateral jsonb_array_elements(rt.rt -> 'players') as pe(value)
       where casts.round_id = p_round_id
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap')
         and casts.cast_inputs ? 'roll_transform'
         and pe.value ->> 'player_id' = v_pid
       order by (rt.rt ->> 'order')::integer, casts.seq
    loop
      -- issue #309: a roll-domain ward pre-empted this transform in the eager
      -- shim -- the roll was not mutated. Emit a `warded` step and keep the
      -- running value unchanged.
      if v_row.is_warded then
        v_before := coalesce(v_running, v_row.p_before);
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', to_jsonb(v_row.cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_row.card_name),
            'caster_player_id', to_jsonb(v_row.caster_id)
          ),
          v_pid,
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object(
            'blocked_cast_id', to_jsonb(v_row.cast_id),
            'ward_cast_id', to_jsonb(v_row.ward_cast_id),
            'ward_card_name', to_jsonb(v_row.ward_card_name),
            'target', to_jsonb(v_pid),
            'would_be_before', v_before,
            'would_be_after', coalesce(v_row.would_be_after, v_before),
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- issue #308: a NEGATED roll transform is logically unwound.
      if v_row.is_negated then
        v_running := coalesce(v_running, v_row.p_before);
        continue;
      end if;

      v_before := coalesce(v_running, v_row.p_before);
      v_after := v_row.p_after;
      v_running := v_after;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_row.kind,
        jsonb_build_object(
          'cast_id', to_jsonb(v_row.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_row.card_name),
          'caster_player_id', to_jsonb(v_row.caster_id)
        ),
        v_pid,
        jsonb_build_object('type', 'roll', 'value', v_before),
        jsonb_build_object('type', 'roll', 'value', v_after)
      ));
      v_step_index := v_step_index + 1;
    end loop;

    -- issue #308: backfire re-applies the victim group's eager roll
    -- transforms once more onto the reactor (this player), after their own.
    if v_has_counters then
      for v_bf in
        select c.id as counter_cast_id, csc.name as card_name, c.caster_id,
               c.cast_inputs -> 'backfire' -> 'transforms' as transforms
          from _rr_clr_rows clr
          join public.spell_casts c on c.id = clr.counter_cast_id
          join public.spell_deck_instances csdi on csdi.id = c.card_instance_id
          join public.spell_cards csc on csc.id = csdi.card_id
         where clr.counter_backfired
           and clr.counter_caster = v_pid
         order by clr.counter_seq
      loop
        for v_t in
          select value
            from jsonb_array_elements(coalesce(v_bf.transforms, '[]'::jsonb)) t(value)
           order by (value->>'order')::int
        loop
          v_before := coalesce(v_running, v_rolls[v_i])::numeric;
          v_after := case v_t->>'kind'
            when 'disadvantage' then least(v_before,
              (v_t->'extra_dice'->>0)::numeric, (v_t->'extra_dice'->>1)::numeric)
            when 'advantage' then greatest(v_before,
              (v_t->'extra_dice'->>0)::numeric, (v_t->'extra_dice'->>1)::numeric)
            when 'forced_reroll' then (v_t->'extra_dice'->>0)::numeric
            when 'roll_flip' then 21 - v_before
            else v_before
          end;
          v_running := v_after;

          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            v_t->>'kind',
            jsonb_build_object(
              'cast_id', to_jsonb(v_bf.counter_cast_id),
              'active_effect_id', null,
              'card_name', to_jsonb(v_bf.card_name),
              'caster_player_id', to_jsonb(v_bf.caster_id)
            ),
            v_pid,
            jsonb_build_object('type', 'roll', 'value', v_before),
            jsonb_build_object('type', 'roll', 'value', v_after),
            jsonb_build_object('backfire', true)
          ));
          v_step_index := v_step_index + 1;
        end loop;
      end loop;
    end if;

    if v_running is not null then
      v_rolls[v_i] := v_running::integer;
    end if;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 4a: gather modifier-bucket effects, normalise, bucket per
  -- target player in application order (spec section 6).
  -- ------------------------------------------------------------------
  for v_row in
    select eff.target_player_id, eff.group_id, eff.effect_kind, eff.effect_params, eff.cast_inputs,
           eff.cast_id, eff.active_effect_id, eff.card_name, eff.caster_player_id, eff.ord
      from (
        select casts.target_player_id,
               casts.card_instance_id as group_id,
               casts.effect_kind,
               casts.effect_params,
               casts.cast_inputs,
               casts.id as cast_id,
               null::uuid as active_effect_id,
               sc.name as card_name,
               casts.caster_id as caster_player_id,
               casts.seq as ord,
               casts.cast_at as ts
          from public.spell_casts casts
          join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
          join public.spell_cards sc on sc.id = sdi.card_id
         where casts.round_id = p_round_id
           and casts.target_pending = false
           and casts.negated = false
           and casts.effect_kind in
             ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
           and sc.duration_rounds is null
        union all
        select sae.target_player_id,
               null::uuid as group_id,
               sae.effect_kind,
               sae.effect_params,
               null::jsonb as cast_inputs,
               null::uuid as cast_id,
               sae.id as active_effect_id,
               sc.name as card_name,
               sae.caster_id as caster_player_id,
               null::bigint as ord,
               sae.created_at as ts
          from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
          join public.spell_cards sc on sc.id = sae.card_id
         where sae.room_id = v_room_id
           and sae.effect_kind in
             ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
      ) eff
     order by eff.ord asc nulls first, eff.ts asc
  loop
    v_eff_target := coalesce(
      case when v_row.cast_id is not null
        then v_redirect_map ->> v_row.cast_id::text
      end,
      v_row.target_player_id
    );

    if not (v_eff_target = any (v_players)) then
      continue;
    end if;

    v_el := jsonb_build_object(
      'ord', coalesce(v_row.ord, 0),
      'kind', v_row.effect_kind,
      'cast_id', v_row.cast_id,
      'active_effect_id', v_row.active_effect_id,
      'card_name', v_row.card_name,
      'caster_player_id', v_row.caster_player_id,
      'target_player', v_eff_target
    );

    if v_row.effect_kind = 'flat_modifier' then
      v_el := v_el || jsonb_build_object('flat', coalesce((v_row.effect_params->>'delta')::numeric, 0));
    elsif v_row.effect_kind = 'dice_modifier' then
      -- #312: dice_modifier's flat contribution is the recorded dice_roll
      -- (raw, unsigned) * sign. An unrolled Pending Spell Die (no dice_roll
      -- key) contributes 0 -- resolve_round never runs with one outstanding
      -- (get_current_layer_rolls_if_complete gates on it, migration 0079).
      v_el := v_el || jsonb_build_object('flat',
        case
          when v_row.cast_inputs ? 'dice_roll'
            then (v_row.cast_inputs->>'dice_roll')::numeric
                 * coalesce((v_row.effect_params->>'sign')::numeric, 1)
          else 0
        end);
    elsif v_row.effect_kind = 'modifier_multiplier' then
      v_el := v_el || jsonb_build_object('mult', coalesce((v_row.effect_params->>'multiplier')::numeric, 1));
    elsif v_row.effect_kind = 'set_modifier' then
      v_el := v_el || jsonb_build_object('set', coalesce((v_row.effect_params->>'value')::numeric, 0));
    end if;

    -- issue #309: ward filter (Phase 2). Drop a modifier-domain effect whose
    -- computed polarity matches an EARLIER-SEQ ward on its effective target;
    -- emit a `warded` step instead of bucketing it. v_row.ord is the cast
    -- seq (NULL for a carried-forward persistent effect -- _rr_ward_hit then
    -- treats every ward as earlier).
    if v_ward_map ? v_eff_target then
      v_ward_idx := array_position(v_players, v_eff_target);
      v_ward_pol := public._rr_el_polarity(v_el, v_base[v_ward_idx]);
      v_ward_hit := public._rr_ward_hit(v_ward_map, v_eff_target, 'modifier', v_ward_pol, v_row.ord);

      if v_ward_hit is not null then
        v_wb_before := v_base[v_ward_idx];
        v_wb_after := public._rr_compose_modifier(v_base[v_ward_idx], jsonb_build_array(v_el));
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', v_el -> 'cast_id',
            'active_effect_id', v_el -> 'active_effect_id',
            'card_name', v_el -> 'card_name',
            'caster_player_id', v_el -> 'caster_player_id'
          ),
          v_eff_target,
          jsonb_build_object('type', 'modifier', 'value', v_wb_before),
          jsonb_build_object('type', 'modifier', 'value', v_wb_after),
          jsonb_build_object(
            'blocked_cast_id', v_el -> 'cast_id',
            'ward_cast_id', v_ward_hit -> 'ward_cast_id',
            'ward_card_name', v_ward_hit -> 'ward_card_name',
            'target', to_jsonb(v_eff_target),
            'would_be_before', v_wb_before,
            'would_be_after', v_wb_after,
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
        v_ward_hit := null;
        continue;
      end if;
      v_ward_hit := null;
    end if;

    v_effects_json := jsonb_set(
      v_effects_json,
      array[v_eff_target],
      (v_effects_json -> v_eff_target) || jsonb_build_array(v_el),
      true
    );
  end loop;

  -- issue #308: backfire re-buckets every lazy modifier row of a backfired
  -- counter's victim group onto the reactor.
  if v_has_counters then
    for v_bf in
      select clr.counter_cast_id, clr.counter_caster, clr.counter_seq,
             csc.name as counter_card_name, c.caster_id as counter_caster_id,
             pr.id as parent_row_id, pr.effect_kind as pr_kind,
             pr.effect_params as pr_params,
             c.cast_inputs -> 'backfire' -> 'dice_rolls' as dice_rolls
        from _rr_clr_rows clr
        join public.spell_casts c on c.id = clr.counter_cast_id
        join public.spell_deck_instances csdi on csdi.id = c.card_instance_id
        join public.spell_cards csc on csc.id = csdi.card_id
        join public.spell_casts pr on pr.card_instance_id = clr.victim_group
         and pr.effect_kind in
           ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
       where clr.counter_backfired
       order by clr.counter_seq, pr.seq
    loop
      if not (v_bf.counter_caster = any (v_players)) then
        continue;
      end if;

      v_el := jsonb_build_object(
        'ord', v_bf.counter_seq,
        'kind', v_bf.pr_kind,
        'cast_id', v_bf.counter_cast_id,
        'active_effect_id', null,
        'card_name', v_bf.counter_card_name,
        'caster_player_id', v_bf.counter_caster_id,
        'target_player', v_bf.counter_caster,
        'backfire', true
      );

      if v_bf.pr_kind = 'flat_modifier' then
        v_el := v_el || jsonb_build_object('flat', coalesce((v_bf.pr_params->>'delta')::numeric, 0));
      elsif v_bf.pr_kind = 'dice_modifier' then
        v_el := v_el || jsonb_build_object('flat',
          coalesce((v_bf.dice_rolls ->> v_bf.parent_row_id::text)::numeric, 0)
          * coalesce((v_bf.pr_params->>'sign')::numeric, 1));
      elsif v_bf.pr_kind = 'modifier_multiplier' then
        v_el := v_el || jsonb_build_object('mult', coalesce((v_bf.pr_params->>'multiplier')::numeric, 1));
      elsif v_bf.pr_kind = 'set_modifier' then
        v_el := v_el || jsonb_build_object('set', coalesce((v_bf.pr_params->>'value')::numeric, 0));
      end if;

      -- issue #309: ward filter also applies to a backfired counter's
      -- re-bucketed rows landing on the reactor (spec §8).
      if v_ward_map ? v_bf.counter_caster then
        v_ward_idx := array_position(v_players, v_bf.counter_caster);
        v_ward_pol := public._rr_el_polarity(v_el, v_base[v_ward_idx]);
        v_ward_hit := public._rr_ward_hit(v_ward_map, v_bf.counter_caster, 'modifier', v_ward_pol, v_bf.counter_seq);

        if v_ward_hit is not null then
          v_wb_before := v_base[v_ward_idx];
          v_wb_after := public._rr_compose_modifier(v_base[v_ward_idx], jsonb_build_array(v_el));
          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            'warded',
            jsonb_build_object(
              'cast_id', v_el -> 'cast_id',
              'active_effect_id', null,
              'card_name', v_el -> 'card_name',
              'caster_player_id', v_el -> 'caster_player_id'
            ),
            v_bf.counter_caster,
            jsonb_build_object('type', 'modifier', 'value', v_wb_before),
            jsonb_build_object('type', 'modifier', 'value', v_wb_after),
            jsonb_build_object(
              'blocked_cast_id', v_el -> 'cast_id',
              'ward_cast_id', v_ward_hit -> 'ward_cast_id',
              'ward_card_name', v_ward_hit -> 'ward_card_name',
              'target', to_jsonb(v_bf.counter_caster),
              'would_be_before', v_wb_before,
              'would_be_after', v_wb_after,
              'backfire', true,
              'outcome', 'blocked'
            )
          ));
          v_step_index := v_step_index + 1;
          v_ward_hit := null;
          continue;
        end if;
        v_ward_hit := null;
      end if;

      v_effects_json := jsonb_set(
        v_effects_json,
        array[v_bf.counter_caster],
        (v_effects_json -> v_bf.counter_caster) || jsonb_build_array(v_el),
        true
      );
    end loop;
  end if;

  -- Compose each player's final modifier, and emit one Trace step per
  -- effect with a running before/after over the prefix up to it.
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_after := v_base[v_i];

    for v_local_idx, v_el in
      select o, value
        from jsonb_array_elements(v_effects_json -> v_pid) with ordinality as e(value, o)
       order by o
    loop
      v_before := v_after;
      v_after := public._rr_compose_modifier(
        v_base[v_i],
        (select coalesce(jsonb_agg(value order by o), '[]'::jsonb)
           from jsonb_array_elements(v_effects_json -> v_pid) with ordinality as e(value, o)
          where o <= v_local_idx)
      );

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_el ->> 'kind',
        jsonb_build_object(
          'cast_id', v_el -> 'cast_id',
          'active_effect_id', v_el -> 'active_effect_id',
          'card_name', v_el -> 'card_name',
          'caster_player_id', v_el -> 'caster_player_id'
        ),
        v_pid,
        jsonb_build_object('type', 'modifier', 'value', v_before),
        jsonb_build_object('type', 'modifier', 'value', v_after),
        case when v_el ? 'backfire'
          then jsonb_build_object('backfire', true)
          else '{}'::jsonb
        end
      ));
      v_step_index := v_step_index + 1;
    end loop;

    v_composed[v_i] := v_after;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 4c: lowest_gains_highest_modifier (Broken Biscuit).
  -- ------------------------------------------------------------------
  select true into v_has_lghm
    from public.spell_casts casts
    join public.spell_reaction_windows w on w.id = casts.reaction_window_id
   where w.round_id = p_round_id and w.layer = 0
     and casts.effect_kind = 'lowest_gains_highest_modifier'
     and casts.negated = false
   limit 1;

  if coalesce(v_has_lghm, false) and coalesce(array_length(v_players, 1), 0) > 0 then
    select casts.id as id, casts.seq as seq, casts.caster_id as caster_id, sc.name as name
      into v_lghm_cast
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where w.round_id = p_round_id and w.layer = 0
       and casts.effect_kind = 'lowest_gains_highest_modifier'
       and casts.negated = false
     order by casts.seq
     limit 1;
    v_lghm_seq := v_lghm_cast.seq;

    v_lowest_roll := (select min(x) from unnest(v_rolls) x);

    select v_composed[array_position(v_players, t.pid)]
      into v_high_roll_composed
      from (
        select v_players[i] as pid
          from generate_subscripts(v_players, 1) i
         order by v_rolls[i] desc, v_players[i]
         limit 1
      ) t;

    for v_i in 1 .. array_length(v_players, 1) loop
      if v_rolls[v_i] = v_lowest_roll then
        -- issue #309: a warded tied-lowest roller is excluded from the lift
        -- (lowest_gains_highest_modifier is statically positive). Others are
        -- still lifted. The lghm cast is a reaction, so its seq is after any
        -- pre-roll ward.
        v_ward_hit := public._rr_ward_hit(v_ward_map, v_players[v_i], 'modifier', 'positive', v_lghm_seq);
        if v_ward_hit is not null then
          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            'warded',
            jsonb_build_object(
              'cast_id', to_jsonb(v_lghm_cast.id),
              'active_effect_id', null,
              'card_name', to_jsonb(v_lghm_cast.name),
              'caster_player_id', to_jsonb(v_lghm_cast.caster_id)
            ),
            v_players[v_i],
            jsonb_build_object('type', 'modifier', 'value', v_composed[v_i]),
            jsonb_build_object('type', 'modifier', 'value', v_composed[v_i]),
            jsonb_build_object(
              'blocked_cast_id', to_jsonb(v_lghm_cast.id),
              'ward_cast_id', v_ward_hit -> 'ward_cast_id',
              'ward_card_name', v_ward_hit -> 'ward_card_name',
              'target', to_jsonb(v_players[v_i]),
              'would_be_before', v_composed[v_i],
              'would_be_after', v_high_roll_composed,
              'outcome', 'blocked'
            )
          ));
          v_step_index := v_step_index + 1;
          v_ward_hit := null;
          continue;
        end if;

        v_before := v_composed[v_i];
        v_after := v_high_roll_composed;
        v_composed[v_i] := v_after;

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'lowest_gains_highest_modifier',
          jsonb_build_object(
            'cast_id', to_jsonb(v_lghm_cast.id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_lghm_cast.name),
            'caster_player_id', to_jsonb(v_lghm_cast.caster_id)
          ),
          v_players[v_i],
          jsonb_build_object('type', 'modifier', 'value', v_before),
          jsonb_build_object('type', 'modifier', 'value', v_after)
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 4b: persistent modifier delta projection (issue #311, spec §9).
  --
  -- Spec §6 numbers this "4b" (adjacent to modifier composition), but it is
  -- coded here, after Phase 4c: the persistent rest-of-day delta is
  -- independent of the round-composed modifier and of 4c's in-place lift of
  -- v_composed, so ordering relative to 4a/4c is immaterial and running last
  -- avoids interleaving with the composed-array walk.
  --
  -- For every player targeted by a non-negated persistent_modifier_transfer
  -- or persistent_modifier_spend cast in THIS round, set the materialized
  -- room_players.modifier cache to base + rest-of-day spell delta and emit one
  -- Trace step per cast with a deterministic running before -> after. Players
  -- not touched by a transfer this round keep their existing modifier -- every
  -- non-spell writer (brewer gain, adjustments, admin tools) and Kettle
  -- Crash's imperative reset stay authoritative for them.
  --
  -- The recompute is absolute (base + full delta), so re-running resolve_round
  -- over the same inputs reproduces the same room_players.modifier and the
  -- same steps. The per-step `before` is derived from base + the delta of
  -- earlier-seq matching casts, never from the live room_players.modifier, so
  -- it does not drift on a second run.
  --
  -- ADR 0005 note: a transfer's `delta` is a cast-time snapshot of a mutable
  -- room_players.modifier (WILD branch 3/5 -- see cast_spell_card). The value
  -- is recorded in the Cast Log, so a replay reproduces it; the swap outcome
  -- is path-dependent on cast timing, the same grudging exception the ADR
  -- grants the eager shim. Within this slice only one snapshot-taking cast per
  -- round is reachable (a single Wild Brew Surge instance in the deck), so no
  -- same-round transfer reads another's not-yet-projected delta.
  -- ------------------------------------------------------------------
  -- Phase 4b-pre (issue #342): Bitter Leech per-round tick synthesis.
  --
  -- Each still-live Bitter Leech active effect (a persistent_modifier_transfer
  -- row carrying a 'per_round_delta') projects one -per_round_delta /
  -- +per_round_delta persistent_modifier_transfer pair into THIS round's Cast
  -- Log -- the target loses, the caster gains. The pair then flows through the
  -- ordinary Phase 4b projection and _rr_spell_modifier_delta /
  -- get_modifier_breakdown exactly like a Chai-nge / WILD transfer, so the
  -- breakdown reconciles for free. Written once per (round, source cast): a
  -- re-resolve finds the tick already present and skips the insert, and the
  -- absolute recompute below reproduces the same room_players.modifier.
  -- Liveness (cast round + next 2 rounds, then stop) is
  -- _rr_active_effects_as_of's call, off the card's duration_rounds = 3.
  for v_bl in
    select sae.source_cast_id,
           sae.target_player_id as victim_id,
           sae.caster_id        as beneficiary_id,
           coalesce((sae.effect_params ->> 'per_round_delta')::numeric, 1) as per_round_delta,
           src.card_instance_id
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_casts src on src.id = sae.source_cast_id
     where sae.room_id = v_room_id
       and sae.effect_kind = 'persistent_modifier_transfer'
       and sae.effect_params ? 'per_round_delta'
  loop
    if exists (
      select 1 from public.spell_casts t
       where t.round_id = p_round_id
         and t.source_cast_id = v_bl.source_cast_id
         and coalesce((t.cast_inputs ->> 'bitter_leech_tick')::boolean, false) = true
         -- generation-scoped like _rr_spell_modifier_delta (0085): a replay
         -- (#315) that bumps the round's replay_generation must re-emit the
         -- tick for the new generation, not skip on the prior one's rows.
         and coalesce(t.generation, 0) = coalesce(v_gen, 0)
    ) then
      continue;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, generation
    )
    values (
      p_round_id, v_bl.beneficiary_id, v_bl.card_instance_id, v_bl.victim_id,
      'persistent_modifier_transfer', jsonb_build_object('delta', -v_bl.per_round_delta),
      jsonb_build_object('bitter_leech_tick', true), v_bl.source_cast_id, coalesce(v_gen, 0)
    );

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, generation
    )
    values (
      p_round_id, v_bl.beneficiary_id, v_bl.card_instance_id, v_bl.beneficiary_id,
      'persistent_modifier_transfer', jsonb_build_object('delta', v_bl.per_round_delta),
      jsonb_build_object('bitter_leech_tick', true), v_bl.source_cast_id, coalesce(v_gen, 0)
    );
  end loop;

  -- issue #342: NO negated filter here -- a fully-negated Chai-nge (both
  -- sibling rows flipped by Phase 1) must still bring both players into the
  -- recompute so their caches revert to base + other-round deltas. The inner
  -- loop below still filters negated rows out of the running sum.
  select coalesce(array_agg(distinct sc.target_player_id), array[]::text[])
    into v_pm_targets
    from public.spell_casts sc
   where sc.round_id = p_round_id
     and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
     and sc.target_player_id is not null;

  foreach v_pid in array v_pm_targets loop
    -- deterministic starting point: base + this player's transfer/spend delta
    -- from every OTHER round of the current generation.
    v_pm_running := public._rr_base_modifier(v_room_id, v_pid)
                  + public._rr_spell_modifier_delta(v_room_id, v_pid, p_round_id);

    for v_pm_row in
      select sc.id as cast_id, sc.seq, sc.caster_id, sc.effect_kind,
             coalesce((sc.effect_params ->> 'delta')::numeric, 0) as delta,
             scn.name as card_name
        from public.spell_casts sc
        join public.spell_deck_instances sdi on sdi.id = sc.card_instance_id
        join public.spell_cards scn on scn.id = sdi.card_id
       where sc.round_id = p_round_id
         and sc.target_player_id = v_pid
         and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
         and coalesce(sc.negated, false) = false
         -- issue #342: skip the Bitter Leech anchor (no 'delta') and match
         -- _rr_spell_modifier_delta's generation filter so the running sum and
         -- the baseline it starts from never disagree after a replay (#315).
         and sc.effect_params ? 'delta'
         and coalesce(sc.generation, 0) = coalesce(v_gen, 0)
       order by sc.seq
    loop
      v_before := v_pm_running;
      v_pm_running := v_pm_running + v_pm_row.delta;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_pm_row.effect_kind,
        jsonb_build_object(
          'cast_id', to_jsonb(v_pm_row.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_pm_row.card_name),
          'caster_player_id', to_jsonb(v_pm_row.caster_id)
        ),
        v_pid,
        jsonb_build_object('type', 'modifier', 'value', v_before),
        jsonb_build_object('type', 'modifier', 'value', v_pm_running),
        jsonb_build_object('delta', v_pm_row.delta, 'rest_of_day', true)
      ));
      v_step_index := v_step_index + 1;
    end loop;

    update public.room_players
       set modifier = v_pm_running::integer
     where room_id = v_room_id and player_id = v_pid;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 5: brewer selection. Precedence declared > override > default.
  -- ------------------------------------------------------------------
  for v_declared in
    select sae.id, (sae.effect_params->>'number')::integer as number,
           sae.caster_id, sc.name as card_name
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_cards sc on sc.id = sae.card_id
     where sae.room_id = v_room_id
       and sae.effect_kind = 'declared_number_tea_maker'
     order by sae.created_at
  loop
    select r.player_id into v_pid
      from public.rolls r
     where r.round_id = p_round_id and r.layer = 0 and r.value = v_declared.number
     limit 1;

    if v_pid is not null then
      v_brewer_id := v_pid;
      v_brewer_source := 'declared_number';
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'declared_number_tea_maker',
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', to_jsonb(v_declared.id),
          'card_name', to_jsonb(v_declared.card_name),
          'caster_player_id', to_jsonb(v_declared.caster_id)
        ),
        v_brewer_id,
        jsonb_build_object('type', 'status', 'value', 'pending'),
        jsonb_build_object('type', 'status', 'value', 'brewer')
      ));
      v_step_index := v_step_index + 1;
      exit;
    end if;
  end loop;

  if v_brewer_id is null then
    select casts.effect_params->>'mode' as mode,
           coalesce((casts.effect_params->>'no_modifier_gain')::boolean, false) as no_modifier_gain,
           casts.target_player_id as chosen_player_id,
           casts.target_pending as target_pending,
           casts.id as cast_id,
           casts.caster_id as caster_id,
           sc.name as card_name
      into v_override
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where casts.round_id = p_round_id
       and casts.effect_kind = 'tea_maker_override'
       and casts.negated = false
     order by casts.cast_at desc, casts.seq desc
     limit 1;

    if v_override.mode is not null and not coalesce(v_override.target_pending, false) then
      if v_override.mode = 'chosen' then
        v_brewer_id := v_override.chosen_player_id;
      elsif v_override.mode = 'highest_roll' then
        select v_players[i] into v_brewer_id
          from generate_subscripts(v_players, 1) i
         order by v_rolls[i] desc, v_players[i]
         limit 1;
      else
        select r.player_id into v_brewer_id
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0
         order by r.modifier_snapshot desc, r.player_id
         limit 1;
      end if;

      v_no_modifier_gain := v_override.no_modifier_gain;
      v_brewer_source := 'tea_maker_override:' || v_override.mode;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'tea_maker_override',
        jsonb_build_object(
          'cast_id', to_jsonb(v_override.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_override.card_name),
          'caster_player_id', to_jsonb(v_override.caster_id)
        ),
        v_brewer_id,
        jsonb_build_object('type', 'status', 'value', 'pending'),
        jsonb_build_object('type', 'status', 'value',
          case when v_no_modifier_gain then 'brewer (no modifier gain)' else 'brewer' end)
      ));
      v_step_index := v_step_index + 1;
    end if;
  end if;

  if v_brewer_id is null then
    v_tied := public._rr_pick_lowest(v_players, v_rolls, v_composed);

    if array_length(v_tied, 1) > 1 then
      update public.rounds set resolution_trace = v_trace where id = p_round_id;
      return jsonb_build_object(
        'outcome', 'tie', 'layer', 0,
        'brewer_id', null, 'brewer_source', null,
        'tied_player_ids', to_jsonb(v_tied),
        'cups_made', v_participant_count, 'no_modifier_gain', false,
        'trace', v_trace
      );
    end if;

    v_brewer_id := v_tied[1];
    v_brewer_source := 'default';
  end if;

  -- issue #309: a block_earned_modifier ward on the selected brewer (Eternal
  -- Steep) zeroes their tea-making modifier gain. resolve_round(uuid, text,
  -- integer, boolean) turns no_modifier_gain into a zero brewer gain. This is
  -- a property of the ward, not a competing cast, so it applies regardless of
  -- seq.
  if v_brewer_id is not null then
    select w.value into v_ward_hit
      from jsonb_array_elements(coalesce(v_ward_map -> v_brewer_id, '[]'::jsonb)) w
     where coalesce((w.value ->> 'block_earned_modifier')::boolean, false)
     limit 1;

    if v_ward_hit is not null then
      if not v_no_modifier_gain then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', null,
            'card_name', v_ward_hit -> 'ward_card_name',
            'caster_player_id', null
          ),
          v_brewer_id,
          jsonb_build_object('type', 'status', 'value', 'brewer'),
          jsonb_build_object('type', 'status', 'value', 'brewer (no modifier gain)'),
          jsonb_build_object(
            'blocked_cast_id', null,
            'ward_cast_id', v_ward_hit -> 'ward_cast_id',
            'ward_card_name', v_ward_hit -> 'ward_card_name',
            'target', to_jsonb(v_brewer_id),
            'would_be_before', to_jsonb('brewer'::text),
            'would_be_after', to_jsonb('brewer (no modifier gain)'::text),
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
      end if;
      v_no_modifier_gain := true;
      v_ward_hit := null;
    end if;
  end if;

  update public.rounds set resolution_trace = v_trace where id = p_round_id;

  return jsonb_build_object(
    'outcome', 'brewer', 'layer', 0,
    'brewer_id', v_brewer_id, 'brewer_source', v_brewer_source,
    'tied_player_ids', null,
    'cups_made', v_participant_count, 'no_modifier_gain', v_no_modifier_gain,
    'trace', v_trace
  );
end;
$$;

revoke execute on function public.resolve_round(uuid) from public, anon;
grant execute on function public.resolve_round(uuid) to authenticated;

comment on function public.resolve_round(uuid) is
  'Authoritative layer-0 outcome resolver (issues #305-#311 / #342, ADR 0005): Phase 1 negate / redirect / backfire; Phase 2 ward projection; Phase 3 roll-input accounting; Phase 4a modifier composition; Phase 4c lowest_gains_highest_modifier; Phase 4b-pre synthesises each live Bitter Leech tick as a persistent_modifier_transfer pair in the Cast Log (issue #342); Phase 4b re-derives room_players.modifier = base + persistent spell delta for every player a transfer / spend cast touched this round (issue #311); Phase 5 brewer selection. Emits the Resolution Trace. Pure and idempotent over its inputs. Layer > 0 bypasses all spell logic (issue #219).';

-- ---------------------------------------------------------------------------
-- 6. rebuild_active_effects_projection(uuid) -- re-emitted from 0084,
--    skips resolve_round's synthetic Bitter Leech tick rows.
-- ---------------------------------------------------------------------------
create or replace function public.rebuild_active_effects_projection(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cast record;
begin
  delete from public.spell_active_effects where room_id = p_room_id;

  for v_cast in
    select sc.id as cast_id, r.room_id, sc.caster_id, sc.target_player_id,
           sdi.card_id, sc.effect_kind, sc.effect_params
      from public.spell_casts sc
      join public.rounds r on r.id = sc.round_id
      join public.spell_deck_instances sdi on sdi.id = sc.card_instance_id
      join public.spell_cards card on card.id = sdi.card_id
     where r.room_id = p_room_id
       -- negated casts are replayed too -- see the header: the incremental
       -- path's physical set keeps them.
       and (
         sc.effect_kind = 'declared_number_tea_maker'
         or (
           sc.target_pending = false
           and sc.target_player_id is not null
           and (card.duration_rounds is not null or sc.effect_kind = 'ward')
           -- issue #342: resolve_round's synthetic Bitter Leech tick rows carry
           -- Bitter Leech's card_instance_id (duration_rounds = 3) but are not
           -- promotion sources -- the real anchor cast already produced the
           -- projection row; replaying them would multiply it.
           and coalesce((sc.cast_inputs ->> 'bitter_leech_tick')::boolean, false) = false
         )
       )
     order by sc.seq
  loop
    if v_cast.effect_kind = 'declared_number_tea_maker' then
      insert into public.spell_active_effects (
        room_id, target_player_id, caster_id, source_cast_id, card_id,
        effect_kind, effect_params, rounds_remaining
      )
      values (
        v_cast.room_id, coalesce(v_cast.target_player_id, v_cast.caster_id),
        v_cast.caster_id, v_cast.cast_id, v_cast.card_id,
        v_cast.effect_kind, v_cast.effect_params, 1   -- one-shot: its cast round only
      );
    else
      perform public.record_active_effect_if_persistent(
        v_cast.room_id, v_cast.caster_id, v_cast.target_player_id,
        v_cast.card_id, v_cast.effect_kind, v_cast.effect_params, v_cast.cast_id
      );
    end if;
  end loop;
end;
$$;

-- Debug / maintenance only: not for players. service_role (backend + the
-- admin/test client) is the sole caller, matching 0048's precedent for
-- open_reaction_window.
revoke execute on function public.rebuild_active_effects_projection(uuid) from public, anon, authenticated;
grant execute on function public.rebuild_active_effects_projection(uuid) to service_role;

comment on function public.rebuild_active_effects_projection(uuid) is
  'Issue #310: debug/maintenance op -- rebuild a room''s spell_active_effects '
  'projection from scratch by replaying its Cast Log in seq order. The '
  'steady-state path stays incremental; this must produce the same row set.';
