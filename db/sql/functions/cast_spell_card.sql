-- cast_spell_card(uuid, text, text[], integer, text) -> uuid
--
-- Arm a spell during the pre-roll (declare-in) window: validation,
-- by-name dispatch, WILD special-casing, Cast-Log write. Verbatim from
-- migration 0096.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.cast_spell_card(
  p_round_id uuid, p_target_player_id text default null,
  p_chosen_player_ids text[] default null, p_declared_number integer default null,
  p_invoked_card_name text default null
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
  -- issue #344: ward interaction for modifier-transfer / snapshot cards
  v_ward_cast_id uuid;
  v_ward_card_name text;
  v_ward_blocked boolean := false;
  v_loser text;
  v_wb_before integer;
  v_wb_after integer;
  v_block_marker jsonb;
  -- issue #316: Genie in the Teapot (Effect Invocation)
  v_is_genie boolean := false;
  v_gen_card_id uuid;
  v_gen_casting_time text;
  v_gen_tier text;
  v_gen_target_stamp text;
  v_gen_in_deck integer;
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

  -- issue #316: Genie in the Teapot (Effect Invocation). Name any OTHER
  -- non-Epic Action card whose sole edition instance is in_deck and resolve
  -- its effect as if played. The named instance is NOT moved (ethereal). The
  -- Genie's own held instance IS consumed. Implemented by rebinding v_card_id
  -- / v_target_stamp to the named card and falling through to the generic
  -- per-effect loop; the Genie's rows carry cast_inputs.invoked_card. A card
  -- Genie cannot express (no non-WILD effect rows, or a by-name special-case)
  -- is a typed RFB50, never a silent burn.
  if v_card_name = 'Genie in the Teapot' then
    if p_invoked_card_name is null then
      raise exception 'cast_spell_card: Genie in the Teapot must name a card'
        using errcode = 'RFB50';
    end if;

    select sc.id, sc.casting_time, sc.tier, sc.target
      into v_gen_card_id, v_gen_casting_time, v_gen_tier, v_gen_target_stamp
      from public.spell_cards sc
     where sc.name = p_invoked_card_name;

    if v_gen_card_id is null then
      raise exception 'cast_spell_card: no card named %', p_invoked_card_name
        using errcode = 'RFB50';
    end if;
    if p_invoked_card_name = 'Genie in the Teapot'
       or v_gen_tier = 'epic'
       or v_gen_casting_time <> 'A' then
      raise exception 'cast_spell_card: Genie can only name a non-Epic Action card'
        using errcode = 'RFB50';
    end if;
    -- Cards cast_spell_card resolves through a bespoke by-name / WILD branch
    -- rather than the generic per-effect loop cannot be invoked this way in
    -- this slice: their real behaviour needs live-modifier snapshots or d6
    -- dispatch the loop can't express, and "no card silently no-ops" (spec
    -- #302) beats a technically-legal-but-inert invocation. This list mirrors
    -- the name-keyed branches earlier in this function + the #342/#343 ones --
    -- keep it in sync if another by-name special-case is added.
    if p_invoked_card_name in (
         'Bes-Tea', 'Tea Leaf', 'Spillage', 'Chai-nge of Heart', 'Bitter Leech',
         'Wild Brew Surge', 'Kettle Crash')
       or v_gen_target_stamp = 'WILD' then
      raise exception 'cast_spell_card: % cannot be invoked by Genie yet', p_invoked_card_name
        using errcode = 'RFB50';
    end if;
    if not exists (
      select 1 from public.spell_card_effects
       where card_id = v_gen_card_id and target_role <> 'WILD'
    ) then
      raise exception 'cast_spell_card: % has no invokable effect', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    -- The named card's sole edition instance must be available in the deck
    -- (held / pending_swap => not nameable). Ethereal: not consumed, not moved.
    select count(*) filter (where location = 'in_deck')
      into v_gen_in_deck
      from public.spell_deck_instances
     where card_id = v_gen_card_id;
    if coalesce(v_gen_in_deck, 0) < 1 then
      raise exception 'cast_spell_card: % is not available in the deck', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    -- Genie picks the target now, following the named card's own rule.
    if v_gen_target_stamp in ('OPPONENT', 'PLAYER') and p_target_player_id is null then
      raise exception 'cast_spell_card: Genie must choose the target for % now', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    v_is_genie := true;
    v_card_id := v_gen_card_id;
    v_target_stamp := v_gen_target_stamp;
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

  -- issue #318: chosen-pair roll transform Action cards. Zero
  -- spell_card_effects rows, so each is a by-name branch emitting one
  -- roll_pair_transform cast; apply_roll_pair_transform runs it at
  -- reaction-window finalize (its pre-roll rows are attached to the layer-0
  -- window by attach_pre_roll_roll_pair_transform_casts, migration 0096) and
  -- resolve_round Phase 3 adopts the result. No deferred-target path this
  -- slice -- an explicit target / pair is required at cast time (RFB46), the
  -- Bes-Tea / Chai-nge of Heart tradeoff.
  --   * Stir the Pot      -- op = swap over two OTHER players (never caster)
  --   * Steaming Mug Bond  -- op = min: caster + target both take the lower d20
  --   * Tea for Two        -- op = max: caster + target both take the higher d20
  if v_card_name in ('Stir the Pot', 'Steaming Mug Bond', 'Tea for Two') then
    if v_card_name = 'Stir the Pot' then
      if coalesce(array_length(p_chosen_player_ids, 1), 0) <> 2 then
        raise exception 'cast_spell_card: Stir the Pot requires exactly two chosen players'
          using errcode = 'RFB46';
      end if;
      if p_chosen_player_ids[1] = p_chosen_player_ids[2] then
        raise exception 'cast_spell_card: chosen players must be distinct'
          using errcode = 'RFB46';
      end if;
      if v_player_id = any (p_chosen_player_ids) then
        raise exception 'cast_spell_card: Stir the Pot cannot choose yourself'
          using errcode = 'RFB46';
      end if;
      foreach v_chosen_id in array p_chosen_player_ids loop
        if not exists (
          select 1 from public.round_participants
           where round_id = p_round_id and player_id = v_chosen_id
        ) then
          raise exception 'cast_spell_card: chosen player is not a participant in this round'
            using errcode = 'RFB46';
        end if;
      end loop;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, false,
        'roll_pair_transform', jsonb_build_object('op', 'swap'),
        jsonb_build_object('pair',
          jsonb_build_array(p_chosen_player_ids[1], p_chosen_player_ids[2])),
        'TABLE'
      )
      returning id into v_cast_id;
    else
      if v_final_target is null then
        raise exception 'cast_spell_card: % requires an explicit target', v_card_name
          using errcode = 'RFB46';
      end if;
      if v_final_target = v_player_id then
        raise exception 'cast_spell_card: this card cannot target yourself'
          using errcode = 'RFB46';
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'roll_pair_transform',
        jsonb_build_object('op',
          case v_card_name when 'Steaming Mug Bond' then 'min' else 'max' end),
        jsonb_build_object('pair', jsonb_build_array(v_player_id, v_final_target)),
        'TARGET'
      )
      returning id into v_cast_id;
    end if;

    return v_cast_id;
  end if;

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

    -- issue #344: ward interaction. Bes-Tea's copy fails against a block_copy
    -- holder; Tea Leaf / Spillage's steal is blocked atomically -- the target
    -- keeps their modifier AND the caster gets no roll bonus -- when the
    -- target holds a matching negative modifier-domain ward. The card is still
    -- spent (the deck instance was returned above); the emitted rows go in
    -- negated with a _rr_ward_block_marker that resolve_round's Pre-pass turns
    -- into one `warded` step. Detection is at cast time: like Bes-Tea's own
    -- source_modifier snapshot these Action cards resolve their inputs when
    -- cast, so a ward cast later the same round (higher seq) does not gate.
    v_ward_blocked := false;
    v_ward_cast_id := null;
    v_ward_card_name := null;
    v_block_marker := '{}'::jsonb;

    if v_card_name = 'Bes-Tea' then
      select sae.source_cast_id, scw.name
        into v_ward_cast_id, v_ward_card_name
        from public.spell_active_effects sae
        join public.spell_cards scw on scw.id = sae.card_id
       where sae.room_id = v_room_id
         and sae.target_player_id = v_final_target
         and sae.effect_kind = 'ward'
         and coalesce((sae.effect_params ->> 'block_copy')::boolean, false) = true
       order by sae.created_at
       limit 1;
      v_ward_blocked := found;
      if v_ward_blocked then
        -- ward_target is the block_copy holder (v_final_target), so the Trace
        -- sentence names the ward holder; the would-be values describe the
        -- caster's round modifier the copy would have set.
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target,
          coalesce((select modifier from public.room_players
                     where room_id = v_room_id and player_id = v_player_id), 0),
          v_target_mod);
      end if;

      -- Copy the target's effective modifier onto the caster for this round.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'set_modifier', jsonb_build_object('value', v_target_mod),
        jsonb_build_object('source_modifier', v_target_mod) || v_block_marker,
        'CASTER', v_ward_blocked
      )
      returning id into v_cast_id;

    elsif v_card_name = 'Tea Leaf' then
      if v_target_mod > 0 then
        select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
          from public._rr_active_ward_gate(
            v_room_id, v_final_target, 'modifier', 'negative', p_round_id, null) g;
        v_ward_blocked := found;
      end if;
      if v_ward_blocked then
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target, v_target_mod, 0);
      end if;

      -- Target's modifier drops to 0 for this round...
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'set_modifier', jsonb_build_object('value', 0),
        jsonb_build_object('stolen_amount', v_target_mod) || v_block_marker,
        'TARGET', v_ward_blocked
      )
      returning id into v_cast_id;

      -- ...and the stolen amount is added to the caster's roll this round.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'flat_modifier', jsonb_build_object('delta', v_target_mod),
        jsonb_build_object('stolen_amount', v_target_mod), 'CASTER', v_ward_blocked
      );

    else
      -- Spillage: floor(m/2) leaves the target and joins the caster's roll
      -- for this round. Postgres integer division truncates toward zero, so
      -- compute the floor explicitly for negative modifiers.
      v_snap := floor(v_target_mod / 2.0)::integer;

      if v_snap > 0 then
        select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
          from public._rr_active_ward_gate(
            v_room_id, v_final_target, 'modifier', 'negative', p_round_id, null) g;
        v_ward_blocked := found;
      end if;
      if v_ward_blocked then
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target,
          v_target_mod, v_target_mod - v_snap);
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'flat_modifier', jsonb_build_object('delta', -v_snap),
        jsonb_build_object('stolen_amount', v_snap) || v_block_marker,
        'TARGET', v_ward_blocked
      )
      returning id into v_cast_id;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'flat_modifier', jsonb_build_object('delta', v_snap),
        jsonb_build_object('stolen_amount', v_snap), 'CASTER', v_ward_blocked
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

    -- issue #344: ward interaction. A swap is atomic -- if the side that LOSES
    -- modifier holds a matching negative modifier-domain ward (Eternal Steep /
    -- Bag for Life / Cast-Iron Kettle) the whole transfer is blocked: both
    -- sibling rows go in negated, so Phase 4b's running-sum filter drops them
    -- while its target gather still reverts both caches to base. The card is
    -- still spent. resolve_round's Pre-pass turns the marker into one `warded`
    -- step. A ward cast later this round (higher seq) does not gate.
    v_ward_blocked := false;
    v_ward_cast_id := null;
    v_ward_card_name := null;
    v_block_marker := '{}'::jsonb;
    -- The caster's transfer row is delta = target_mod - caster_mod, so the
    -- caster is the losing side when target_mod < caster_mod (and vice versa).
    if v_target_mod < v_caster_mod then
      v_loser := v_player_id;    v_wb_before := v_caster_mod; v_wb_after := v_target_mod;
    elsif v_caster_mod < v_target_mod then
      v_loser := v_final_target; v_wb_before := v_target_mod; v_wb_after := v_caster_mod;
    else
      v_loser := null;   -- equal modifiers: the swap moves nothing
    end if;

    if v_loser is not null then
      select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
        from public._rr_active_ward_gate(
          v_room_id, v_loser, 'modifier', 'negative', p_round_id, null) g;
      v_ward_blocked := found;
    end if;
    if v_ward_blocked then
      v_block_marker := public._rr_ward_block_marker(
        v_ward_cast_id, v_ward_card_name, v_loser, v_wb_before, v_wb_after);
    end if;

    -- Sibling persistent_modifier_transfer pair: caster gains (target - caster),
    -- target gains (caster - target) -> their effective modifiers swap for the
    -- rest of the day. resolve_round Phase 4b projects both into
    -- room_players.modifier; whole-cast negation (shared card_instance_id)
    -- drops both. cast_inputs snapshots both effective modifiers at cast time.
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, negated
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id,
      'persistent_modifier_transfer',
      jsonb_build_object('delta', v_target_mod - v_caster_mod),
      jsonb_build_object('caster_modifier', v_caster_mod, 'target_modifier', v_target_mod) || v_block_marker,
      v_ward_blocked
    )
    returning id into v_cast_id;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, negated
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target,
      'persistent_modifier_transfer',
      jsonb_build_object('delta', v_caster_mod - v_target_mod),
      jsonb_build_object('caster_modifier', v_caster_mod, 'target_modifier', v_target_mod),
      v_cast_id, v_ward_blocked
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

  -- issue #316: tag every row the Genie emitted with the card it invoked, so
  -- the Cast Log / Recap show it resolved "as if you had played" that card.
  if v_is_genie then
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                         || jsonb_build_object('invoked_card', p_invoked_card_name)
     where round_id = p_round_id
       and card_instance_id = v_instance_id
       and caster_id = v_player_id;
  end if;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_spell_card(uuid, text, text[], integer, text) from public, anon;
grant execute on function public.cast_spell_card(uuid, text, text[], integer, text) to authenticated;
