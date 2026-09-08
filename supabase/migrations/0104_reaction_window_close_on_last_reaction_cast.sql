-- Fixes issue #387: casting the last (or only) Reaction card held among a
-- round's participants strands the round on "Reaction Window Open" forever.
--
-- cast_reaction_spell_card (0021, last re-emitted by 0096) ends every path --
-- the generic spell_card_effects loop and every by-name early return
-- (Brew-tal Swap, Saucerer's Apprentice / Brew-merang, Tea-tally Spent) --
-- by bumping spell_reaction_windows.poll_round to reopen the chaining poll
-- (0068) for the other eligible holders. It never re-checked whether any
-- eligible holder is actually left: the cast moves the caster's
-- spell_deck_instances row back to 'in_deck', so if they held the last
-- Reaction card in the round, count_eligible_reaction_holders is now 0 while
-- the window is still status = 'open'. No client renders a Pass affordance,
-- pass_reaction_window is never called, close_reaction_window never fires,
-- and finalizeReactionWindow never runs -- the round cannot resolve.
--
-- This is the same bug class as #251, which migration 0064 fixed for
-- open_reaction_window and resolve_card_swap by having them call
-- count_eligible_reaction_holders -> close_reaction_window when the count
-- hits 0. cast_reaction_spell_card was never given the same guard.
--
-- _rr_reopen_or_close_reaction_poll factors out the "bump the poll, but
-- close the window instead if nobody eligible is left" tail so all four
-- return paths in cast_reaction_spell_card share one definition (same
-- can't-drift reasoning behind 0064's count_eligible_reaction_holders /
-- close_reaction_window split). The client side (castReactionSpellCardAction)
-- now checks get_open_reaction_window after the cast and, when the window is
-- gone, finalizes the layer in the same request -- mirroring what
-- passReactionWindowAction and resolveCardSwapAction already do.

create or replace function public._rr_reopen_or_close_reaction_poll(
  p_round_id uuid, p_window_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.spell_reaction_windows
     set poll_round = poll_round + 1
   where id = p_window_id;

  if public.count_eligible_reaction_holders(p_round_id) = 0 then
    perform public.close_reaction_window(p_window_id);
  end if;
end;
$$;

revoke execute on function public._rr_reopen_or_close_reaction_poll(uuid, uuid) from public, anon;
grant execute on function public._rr_reopen_or_close_reaction_poll(uuid, uuid) to authenticated;

-- cast_reaction_spell_card re-emitted verbatim from migration 0096, with the
-- four inline `update ... set poll_round = poll_round + 1` tails replaced by a
-- call to the helper above. No other change.

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
  -- issue #316: Effect Invocation (Saucerer's Apprentice / Brew-merang)
  v_src_caster text;
  v_src_group uuid;
  v_src_card_name text;
  v_src_parent uuid;
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

  -- issue #318: Brew-tal Swap (Reaction, OPPONENT) -- swap the caster's d20
  -- with the target's. Zero spell_card_effects rows, so it is a by-name
  -- branch emitting one roll_pair_transform cast (op = swap) with the pair
  -- recorded in cast_inputs; apply_roll_pair_transform runs it at
  -- reaction-window finalize and resolve_round Phase 3 adopts the result.
  -- target_role convention across the four #318 cards: 'TARGET' when a single
  -- non-caster is named (Brew-tal Swap / Steaming Mug Bond / Tea for Two),
  -- 'TABLE' when the caster names two others (Stir the Pot). The pair itself
  -- is authoritative in cast_inputs.pair; the resolver never reads target_role
  -- for these rows.
  if v_card_name = 'Brew-tal Swap' then
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target, false,
      'roll_pair_transform', jsonb_build_object('op', 'swap'),
      jsonb_build_object('pair', jsonb_build_array(v_player_id, v_final_target)),
      v_window_id, 'TARGET'
    )
    returning id into v_cast_id;

    perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

    return v_cast_id;
  end if;

  -- issue #316: Effect Invocation -- Saucerer's Apprentice (copy) and
  -- Brew-merang (seize). Both are CARD-targeted Reactions with NO
  -- spell_card_effects rows, so the generic loop below would burn the card for
  -- nothing. Instead emit a single effect_kind = NULL invoking row carrying a
  -- pointer in cast_inputs; resolve_round Phase 0 derives the real effect.
  if v_card_name in ('Saucerer''s Apprentice', 'Brew-merang') then
    select src.caster_id, src.card_instance_id, srcn.name, src.parent_cast_id
      into v_src_caster, v_src_group, v_src_card_name, v_src_parent
      from public.spell_casts src
      join public.spell_deck_instances srcsdi on srcsdi.id = src.card_instance_id
      join public.spell_cards srcn on srcn.id = srcsdi.card_id
     where src.id = p_target_cast_id and src.round_id = p_round_id
     limit 1;

    if v_src_caster is null then
      raise exception 'cast_reaction_spell_card: target cast not found in this round';
    end if;

    -- No meta-invocation (spec §10): invocation cards cannot invoke each other.
    if v_src_card_name in ('Saucerer''s Apprentice', 'Brew-merang', 'Genie in the Teapot') then
      raise exception 'cast_reaction_spell_card: an invocation card cannot invoke another invocation card'
        using errcode = 'RFB49';
    end if;

    -- Brew-merang seizes ANOTHER player's cast (card text: "When another
    -- player plays a card").
    if v_card_name = 'Brew-merang' and v_src_caster = v_player_id then
      raise exception 'cast_reaction_spell_card: Brew-merang can only seize another player''s cast'
        using errcode = 'RFB49';
    end if;

    if v_card_name = 'Brew-merang' then
      v_cast_inputs := jsonb_build_object('seized_cast_id', p_target_cast_id);
    else
      -- Saucerer's Apprentice: draw every fresh copy RNG now (a copied d20 /
      -- dice re-rolls, a copied eager roll cast gets a synthesised
      -- roll_transform onto this caster) so resolve_round stays pure.
      v_cast_inputs := jsonb_build_object('copied_cast_id', p_target_cast_id)
        || jsonb_build_object('copy_inputs',
             public._rr_build_copy_inputs(p_round_id, p_target_cast_id, v_player_id));
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, null, false,
      null, '{}'::jsonb, v_cast_inputs, p_target_cast_id, v_window_id, 'CARD'
    )
    returning id into v_cast_id;

    perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

    return v_cast_id;
  end if;

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

    perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

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

  perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

  return v_cast_id;
end;
$$;
