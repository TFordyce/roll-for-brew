-- Spell Cards: TABLE/WILD casting support (issue #115, child of #51). Teaches
-- cast_spell_card/cast_reaction_spell_card to resolve the TABLE/ALL_OTHER_PLAYERS/
-- CHOSEN_PLAYERS/WILD target_role values 0032 reserved but rejected outright,
-- and maps the 13 currently-unmapped TABLE/WILD-stamped cards (research/
-- spell-cards-effect-mapping.md's "TABLE/WILD target" gap) to concrete
-- effect_kind/effect_params.
--
-- New effect_kind primitives, and why each needs one:
--   reset_persistent_modifier  - zeroes room_players.modifier for the whole
--                                 room, immediately (Kettle Crash, Wild Brew
--                                 Surge branch 1). Room-wide, not
--                                 round-participant-scoped, so no fan-out.
--   persistent_modifier_delta  - adds effect_params.delta to one player's
--                                 room_players.modifier, immediately, no
--                                 expiry (Wild Brew Surge branch 2).
--   persistent_modifier_swap   - swaps two players' room_players.modifier,
--                                 immediately; effect_params.mode picks which
--                                 two ('random' vs 'extremes') (Wild Brew
--                                 Surge branches 3/5).
--   roll_swap / roll_flip /
--   lowest_gains_highest_modifier
--                               - roll-value transforms resolved at reaction-
--                                 window finalize time, the same "UPDATE
--                                 rolls.value in place, patch the in-memory
--                                 array, re-run resolveLayer" precedent
--                                 apply_forced_reroll (0021) already
--                                 established for Double Dunk/Milk First?.
--                                 One event per round, not per player, so a
--                                 single spell_casts row (target_player_id
--                                 null) is enough — the new apply_* RPCs
--                                 below find who's affected dynamically.
--   tea_maker_override          - marks that this round's brewer should be
--                                 chosen by a rule other than resolveLayer's
--                                 normal lowest-roll-wins (Drip Tray/highest
--                                 modifier, Topsy-Tea/highest roll, Wild Brew
--                                 Surge branch 6/chosen). Consumed client-side
--                                 in applyLayerOutcome before resolveLayer
--                                 runs, same "SQL persists, TS decides" split
--                                 as brewer selection already has today.
--   declared_number_tea_maker   - Inscribed Saucer: persists across rounds
--                                 (spell_active_effects, not spell_casts)
--                                 until some future roll matches the declared
--                                 number, then is consumed and deleted.
--   wild_dispatch                - marker only; Wild Brew Surge's d6 branch is
--                                 rolled and dispatched inline in
--                                 cast_spell_card (not data-driven, since the
--                                 six outcomes are mutually exclusive
--                                 alternatives, not simultaneous effect rows).
--
-- Simplification, called out explicitly: Time for Brew's card text ("scrap
-- the result, the round is replayed entirely — new rolls, new cards may be
-- played") describes a true state-rollback/replay that would need to unwind
-- an already-resolved round, well beyond this ticket's plumbing scope. It's
-- mapped here to the same 'forced_reroll'/TABLE shape as Tea-M Reroll
-- (everyone rerolls, brewer is redetermined from the new rolls) — a
-- deliberately narrower reading that reuses proven machinery instead of
-- building round-undo. Flagged for follow-up if the narrower reading isn't
-- good enough at the table.
alter table public.spell_card_effects drop constraint spell_card_effects_effect_kind_check;
alter table public.spell_card_effects add constraint spell_card_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'hidden_modifier', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier', 'persistent_modifier_delta', 'persistent_modifier_swap',
    'roll_swap', 'roll_flip', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch'
  ));

-- declared_number_tea_maker is the only one of the new kinds that's
-- persistent (it must survive until some future round's roll matches it) —
-- the rest resolve within the round/window they're cast in, so they never
-- reach spell_active_effects.
alter table public.spell_active_effects drop constraint spell_active_effects_effect_kind_check;
alter table public.spell_active_effects add constraint spell_active_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'hidden_modifier',
    'declared_number_tea_maker'
  ));

-- CHOSEN_PLAYERS needs its own card-level stamp (distinct from OPPONENT/
-- PLAYER's single-target shape) so cast_spell_card's targeting block below
-- can tell it apart; Calami-Tea is the only card that needs it today.
alter table public.spell_cards drop constraint spell_cards_target_check;
alter table public.spell_cards add constraint spell_cards_target_check
  check (target in ('SELF', 'OPPONENT', 'PLAYER', 'TABLE', 'CARD', 'WILD', 'CHOSEN_PLAYERS'));

update public.spell_cards set target = 'CHOSEN_PLAYERS' where name = 'Calami-Tea';

-- Records, per spell_casts row, which spell_card_effects.target_role
-- produced it (CASTER/TARGET rows leave it null, unchanged behaviour) — the
-- only reader is close_round below, which needs to tell a TABLE/
-- ALL_OTHER_PLAYERS placeholder (awaiting the final round_participants
-- roster) apart from an ordinary deferred OPPONENT/PLAYER pending cast,
-- which it must leave alone for set_spell_cast_target to fill in later.
alter table public.spell_casts add column if not exists target_role text;

-- Effect rows for the 13 previously-unmapped TABLE/WILD cards, plus
-- Calami-Tea (the only current CHOSEN_PLAYERS candidate — needed to exercise
-- that role and its cast-time picker end-to-end). Simplified where the card
-- text's exact number doesn't cleanly fit an existing primitive (Calami-Tea's
-- 1d4 becomes a flat -2 approximation, same reasoning as Time for Brew above
-- — reuse the generic modifier-bucket/persistence machinery rather than add
-- a bespoke "per-round dice reroll for N rounds" primitive for one card).
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params) values
  ((select id from public.spell_cards where name = 'Boil Over'), 'TABLE', 'set_modifier', '{"value": 0}'::jsonb),
  ((select id from public.spell_cards where name = 'Tea-M Reroll'), 'TABLE', 'forced_reroll', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Dunkin Disaster'), 'TABLE', 'roll_swap', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Broken Biscuit'), 'TABLE', 'lowest_gains_highest_modifier', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Drip Tray'), 'TABLE', 'tea_maker_override', '{"mode": "highest_modifier", "no_modifier_gain": true}'::jsonb),
  ((select id from public.spell_cards where name = 'Inscribed Saucer'), 'TABLE', 'declared_number_tea_maker', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Scalding Pour'), 'ALL_OTHER_PLAYERS', 'flat_modifier', '{"delta": -3}'::jsonb),
  ((select id from public.spell_cards where name = 'Kettle Crash'), 'TABLE', 'reset_persistent_modifier', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Wild Brew Surge'), 'WILD', 'wild_dispatch', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Time for Brew'), 'TABLE', 'forced_reroll', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Zariel''s Fall'), 'TABLE', 'roll_flip', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Topsy-Tea'), 'TABLE', 'tea_maker_override', '{"mode": "highest_roll"}'::jsonb),
  ((select id from public.spell_cards where name = 'Kettle Storm'), 'ALL_OTHER_PLAYERS', 'flat_modifier', '{"delta": -8}'::jsonb),
  ((select id from public.spell_cards where name = 'Calami-Tea'), 'CHOSEN_PLAYERS', 'flat_modifier', '{"delta": -2, "max_targets": 3}'::jsonb);

update public.spell_cards set duration_rounds = 3, polarity = 'negative' where name = 'Calami-Tea';

-- Redefines cast_spell_card (0032) to accept TABLE/WILD-stamped cards and a
-- new CHOSEN_PLAYERS-shaped param, instead of rejecting them outright.
--
-- TABLE/ALL_OTHER_PLAYERS modifier-bucket/forced_reroll effect rows can't
-- resolve their full target set here: cast_spell_card only ever runs while
-- the round is 'open' (declare-in), and round_participants isn't final until
-- close_round — the same reason OPPONENT/PLAYER cards defer via
-- target_pending. So those rows are inserted as a single placeholder
-- (target_player_id null, target_pending true, target_role recorded) and
-- fanned out to every participant by close_round below, once the roster is
-- locked. Every other new kind (roll_swap/roll_flip/lowest_gains_highest_
-- modifier/tea_maker_override/declared_number_tea_maker) is a single
-- table-wide event, not a per-player row, so it's inserted once and resolved
-- immediately — no participant list needed at all.
-- Grew two new trailing params — same as record_active_effect_if_persistent
-- in 0032, create-or-replace treats a different parameter-type list as a new
-- overload rather than replacing this one in place, so the old 2-arg
-- signature must be dropped first (otherwise PostgREST/supabase.rpc's
-- named-parameter call could still resolve to the old TABLE/WILD-rejecting
-- version).
drop function if exists public.cast_spell_card(uuid, text);

create function public.cast_spell_card(
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

    v_resolved_value := null;

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

-- Small helper factored out of the WILD dispatch block above (branches 3/5
-- both swap two players' persistent room_players.modifier) — a plain two-row
-- UPDATE, same trust boundary as resolve_round's own room_players write
-- (security definer, no caller-facing grant needed since it's only ever
-- called from within cast_spell_card).
create or replace function public.swap_room_player_modifiers(p_room_id uuid, p_player_a text, p_player_b text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mod_a integer;
  v_mod_b integer;
begin
  select modifier into v_mod_a from public.room_players where room_id = p_room_id and player_id = p_player_a;
  select modifier into v_mod_b from public.room_players where room_id = p_room_id and player_id = p_player_b;

  update public.room_players set modifier = v_mod_b where room_id = p_room_id and player_id = p_player_a;
  update public.room_players set modifier = v_mod_a where room_id = p_room_id and player_id = p_player_b;
end;
$$;

revoke execute on function public.swap_room_player_modifiers(uuid, text, text) from public, anon, authenticated;

-- Redefines cast_reaction_spell_card (0032) to accept TABLE-stamped Reaction
-- cards (Dunkin Disaster, Broken Biscuit, Zariel's Fall, Time for Brew) the
-- same way cast_spell_card now does, minus the deferral complication:
-- Reaction casting only ever happens after a layer's rolls are revealed, by
-- which point round_participants is long final, so TABLE/ALL_OTHER_PLAYERS
-- modifier-bucket/forced_reroll effects fan out to the roster immediately
-- instead of needing close_round's placeholder dance.
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

    v_resolved_value := null;

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

-- Redefines close_round (0026) to fan out any TABLE/ALL_OTHER_PLAYERS
-- placeholder rows cast_spell_card armed while the round was still 'open'
-- (round_participants wasn't final yet) across the now-locked roster —
-- mirrors set_spell_cast_target's job for deferred OPPONENT/PLAYER casts,
-- but automatic (there's no single player for the caster to pick for a
-- table-wide effect). The placeholder itself is left as-is (target_pending
-- stays true, target_player_id stays null) — get_round_modifier_effects and
-- get_forced_reroll_targets already only read target_pending = false rows,
-- so it's harmlessly excluded from here on.
create or replace function public.close_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_started_by text;
  v_declared_count integer;
  v_room_id uuid;
  v_placeholder record;
  v_participant record;
  v_resolved_value numeric;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
  v_card_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, started_by, room_id into v_status, v_started_by, v_room_id
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'close_round: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'close_round: round is not open';
  end if;

  if v_started_by <> v_player_id then
    raise exception 'close_round: only the round starter can close declarations';
  end if;

  select count(*) into v_declared_count
    from public.round_participants
   where round_id = p_round_id;

  if v_declared_count < 2 then
    raise exception 'close_round: at least 2 players must declare in before closing';
  end if;

  update public.rounds set status = 'closed', closed_at = now() where id = p_round_id;

  for v_placeholder in
    select id, caster_id, effect_kind, effect_params, card_instance_id, target_role
      from public.spell_casts
     where round_id = p_round_id
       and target_pending = true
       and target_player_id is null
       and target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
  loop
    select sc.id into v_card_id
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.id = v_placeholder.card_instance_id;

    for v_participant in
      select rp.player_id
        from public.round_participants rp
       where rp.round_id = p_round_id
         and (v_placeholder.target_role <> 'ALL_OTHER_PLAYERS' or rp.player_id <> v_placeholder.caster_id)
    loop
      v_resolved_value := null;

      if v_placeholder.effect_kind = 'dice_modifier' then
        v_dice_count := (regexp_match(v_placeholder.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
        v_dice_sides := (regexp_match(v_placeholder.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
        v_dice_sign := coalesce((v_placeholder.effect_params ->> 'sign')::integer, 1);

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
        p_round_id, v_placeholder.caster_id, v_placeholder.card_instance_id, v_participant.player_id, false,
        v_placeholder.effect_kind, v_placeholder.effect_params, v_resolved_value, v_placeholder.target_role
      );

      perform public.record_active_effect_if_persistent(
        v_room_id, v_placeholder.caster_id, v_participant.player_id, v_card_id,
        v_placeholder.effect_kind, v_placeholder.effect_params, v_placeholder.id
      );
    end loop;
  end loop;
end;
$$;

revoke execute on function public.close_round(uuid) from public, anon;
grant execute on function public.close_round(uuid) to authenticated;

-- Roll-transform RPCs, same shape/trust boundary as apply_forced_reroll
-- (0021): caller-triggered (via finalizeReactionWindow, once it sees an
-- active cast of the matching kind for the layer), server-computed,
-- persisted in place. Each returns every row it changed so the TS caller can
-- patch its in-memory rolls array the same way it already does for
-- apply_forced_reroll.
create or replace function public.apply_roll_swap(p_round_id uuid, p_layer integer)
returns table (player_id text, value integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_high_player text;
  v_low_player text;
  v_high_value integer;
  v_low_value integer;
begin
  select r.player_id, r.value into v_high_player, v_high_value
    from public.rolls r
   where r.round_id = p_round_id and r.layer = p_layer
   order by r.value desc, r.player_id
   limit 1;

  select r.player_id, r.value into v_low_player, v_low_value
    from public.rolls r
   where r.round_id = p_round_id and r.layer = p_layer
   order by r.value asc, r.player_id
   limit 1;

  if v_high_player is null or v_low_player is null or v_high_player = v_low_player then
    return;
  end if;

  update public.rolls set value = v_low_value where round_id = p_round_id and layer = p_layer and player_id = v_high_player;
  update public.rolls set value = v_high_value where round_id = p_round_id and layer = p_layer and player_id = v_low_player;

  return query
    select v_high_player, v_low_value
    union all
    select v_low_player, v_high_value;
end;
$$;

revoke execute on function public.apply_roll_swap(uuid, integer) from public, anon;
grant execute on function public.apply_roll_swap(uuid, integer) to authenticated;

create or replace function public.apply_roll_flip(p_round_id uuid, p_layer integer)
returns table (player_id text, value integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rolls
     set value = 21 - value
   where round_id = p_round_id and layer = p_layer;

  return query
    select r.player_id, r.value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = p_layer;
end;
$$;

revoke execute on function public.apply_roll_flip(uuid, integer) from public, anon;
grant execute on function public.apply_roll_flip(uuid, integer) to authenticated;

create or replace function public.apply_lowest_gains_highest_modifier(p_round_id uuid, p_layer integer)
returns table (player_id text, value integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_lowest_player text;
  v_highest_modifier integer;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  select r.player_id into v_lowest_player
    from public.rolls r
   where r.round_id = p_round_id and r.layer = p_layer
   order by r.value asc, r.player_id
   limit 1;

  select max(rpl.modifier) into v_highest_modifier
    from public.round_participants rp
    join public.room_players rpl on rpl.room_id = v_room_id and rpl.player_id = rp.player_id
   where rp.round_id = p_round_id;

  if v_lowest_player is null or v_highest_modifier is null then
    return;
  end if;

  update public.rolls
     set value = least(20, value + v_highest_modifier)
   where round_id = p_round_id and layer = p_layer and player_id = v_lowest_player;

  return query
    select r.player_id, r.value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_lowest_player;
end;
$$;

revoke execute on function public.apply_lowest_gains_highest_modifier(uuid, integer) from public, anon;
grant execute on function public.apply_lowest_gains_highest_modifier(uuid, integer) to authenticated;

-- Whether any un-negated cast of the given kind is active for a round/layer's
-- reaction window — the same source finalizeReactionWindow's forced-reroll
-- step already reads (get_forced_reroll_targets), generalized so the three
-- new roll-transform kinds above can each be gated the same way without
-- three near-identical existence-check RPCs.
create or replace function public.has_active_cast_kind(p_round_id uuid, p_layer integer, p_effect_kind text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = p_effect_kind
       and casts.negated = false
  );
end;
$$;

revoke execute on function public.has_active_cast_kind(uuid, integer, text) from public, anon;
grant execute on function public.has_active_cast_kind(uuid, integer, text) to authenticated;

-- The round's active tea_maker_override (Drip Tray/Topsy-Tea/Wild Brew
-- Surge branch 6), if any, for applyLayerOutcome to consult before calling
-- resolveLayer — brewer selection is TS-owned (resolveLayer/layerResolution.ts,
-- see #115's research pass), this just surfaces the override's shape.
-- 'chosen' mode isn't resolvable until its (possibly still-pending) target is
-- filled in, so a pending row is reported with target_pending = true and no
-- chosen_player_id, and the caller should wait rather than treat it as absent.
create or replace function public.get_tea_maker_override(p_round_id uuid)
returns table (mode text, no_modifier_gain boolean, chosen_player_id text, target_pending boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'get_tea_maker_override: caller is not a participant in this round';
  end if;

  return query
    select
      casts.effect_params ->> 'mode',
      coalesce((casts.effect_params ->> 'no_modifier_gain')::boolean, false),
      casts.target_player_id,
      casts.target_pending
      from public.spell_casts casts
     where casts.round_id = p_round_id
       and casts.effect_kind = 'tea_maker_override'
       and casts.negated = false
     order by casts.cast_at desc
     limit 1;
end;
$$;

revoke execute on function public.get_tea_maker_override(uuid) from public, anon;
grant execute on function public.get_tea_maker_override(uuid) to authenticated;

-- Checks a just-completed layer's rolls against any live declared_number_tea_
-- maker effect in the room (Inscribed Saucer) and, on a match, consumes it
-- (one-time trigger, per the card text) and reports who it names as brewer.
-- Raw roll value only ("regardless of totals" per the card text, i.e. before
-- any modifier-bucket effects apply) — same rolls the layer's own
-- get_current_layer_rolls_if_complete already returned to the caller.
create or replace function public.resolve_declared_number_tea_maker(p_round_id uuid, p_layer integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_effect_id uuid;
  v_number integer;
  v_matched_player text;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  for v_effect_id, v_number in
    select sae.id, (sae.effect_params ->> 'number')::integer
      from public.spell_active_effects sae
     where sae.room_id = v_room_id and sae.effect_kind = 'declared_number_tea_maker'
     order by sae.created_at
  loop
    select r.player_id into v_matched_player
      from public.rolls r
     where r.round_id = p_round_id and r.layer = p_layer and r.value = v_number
     limit 1;

    if v_matched_player is not null then
      delete from public.spell_active_effects where id = v_effect_id;
      return v_matched_player;
    end if;
  end loop;

  return null;
end;
$$;

revoke execute on function public.resolve_declared_number_tea_maker(uuid, integer) from public, anon;
grant execute on function public.resolve_declared_number_tea_maker(uuid, integer) to authenticated;

-- Redefines resolve_round (0020) with an additional p_no_modifier_gain
-- param (default false, so every existing call site is unaffected) for
-- Drip Tray's "they gain no modifier from this tea-making" clause — the only
-- new-primitive card that changes resolve_round's own write, everything else
-- above only ever changes what feeds INTO brewer selection, not what
-- resolve_round does with the brewer it's given.
drop function if exists public.resolve_round(uuid, text, integer);

create function public.resolve_round(
  p_round_id uuid, p_brewer_id text, p_cups_made integer, p_no_modifier_gain boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_participant_count integer;
  v_expected_layer_count integer;
  v_roll_count integer;
begin
  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = p_brewer_id
  ) then
    raise exception 'resolve_round: brewer is not a participant in this round';
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

  if p_cups_made <> v_participant_count then
    raise exception 'resolve_round: cups_made must equal the round''s participant count';
  end if;

  update public.rounds
     set status = 'resolved',
         brewer_id = p_brewer_id,
         cups_made = p_cups_made,
         resolved_at = now()
   where id = p_round_id;

  if not p_no_modifier_gain then
    update public.room_players
       set modifier = modifier + p_cups_made
     where room_id = v_room_id and player_id = p_brewer_id;
  end if;

  update public.spell_active_effects
     set rounds_remaining = rounds_remaining - 1
   where room_id = v_room_id;

  delete from public.spell_active_effects
   where room_id = v_room_id and rounds_remaining <= 0;
end;
$$;

-- Redefines open_reaction_window (0021) to attach any still-unattached
-- pre-roll-armed forced_reroll cast (Wild Brew Surge branch 4 is the only
-- source today — see cast_spell_card's WILD dispatch above) to the layer-0
-- window it opens: those rows are inserted with reaction_window_id null
-- because no window exists yet at pre-roll cast time, and
-- get_forced_reroll_targets only ever looks at window-scoped rows. Scoped to
-- layer = 0 because a table-wide pre-roll cast only ever concerns the
-- round's first layer; a later tie-break layer's own window has nothing of
-- this shape to pick up.
create or replace function public.open_reaction_window(p_round_id uuid, p_layer integer)
returns table (window_id uuid, is_closed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_id uuid;
  v_eligible_count integer;
begin
  if not exists (select 1 from public.rounds where id = p_round_id) then
    raise exception 'open_reaction_window: round not found';
  end if;

  insert into public.spell_reaction_windows (round_id, layer)
  values (p_round_id, p_layer)
  returning id into v_window_id;

  if p_layer = 0 then
    update public.spell_casts
       set reaction_window_id = v_window_id
     where round_id = p_round_id
       and effect_kind = 'forced_reroll'
       and reaction_window_id is null
       and target_pending = false
       and negated = false;
  end if;

  select count(*) into v_eligible_count
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.round_participants rp on rp.player_id = sdi.held_by_player
   where sdi.location = 'held' and sc.casting_time = 'R' and rp.round_id = p_round_id;

  if v_eligible_count = 0 then
    update public.spell_reaction_windows set status = 'closed', closed_at = now()
     where id = v_window_id;
  end if;

  window_id := v_window_id;
  is_closed := v_eligible_count = 0;
  return next;
end;
$$;

revoke execute on function public.open_reaction_window(uuid, integer) from public, anon;
grant execute on function public.open_reaction_window(uuid, integer) to authenticated;

revoke execute on function public.resolve_round(uuid, text, integer, boolean) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer, boolean) to authenticated;
