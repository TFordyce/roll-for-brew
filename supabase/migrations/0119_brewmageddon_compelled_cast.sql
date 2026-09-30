-- Issue #440 (spec #401, design #385): Brewmageddon -- Compelled Cast and
-- Forfeit (CONTEXT.md).
--
-- "All players must immediately play their spell card this round. Players
-- holding no card are unaffected."
--
-- The model, in one place:
--  * Brewmageddon is an ordinary Action / TABLE cast: one `compel_cast` row.
--  * close_round fixes the compelled set onto that row as
--    cast_inputs.compelled = [{ player_id, card_instance_id, casting_time }]:
--    every non-excluded participant holding a card at close. The set is
--    fixed once and is not an active effect, so a Round replay (whose scrap
--    deletes the cast) never re-fires it.
--  * An obligation is met by any spell_casts row the holder makes with that
--    card instance carrying cast_inputs.compelled_by = the Brewmageddon cast:
--    a compelled cast, or a `forfeit` row. _compelled_outstanding derives
--    what is still owed; nothing is counted or flagged separately.
--  * Compelled Cast step: while any Action holder still owes a cast, nobody
--    rolls (is_expected_layer_roller is false at Layer 0, and Layer 0 is held
--    incomplete). cast_spell_card / end_active_effect accept a compelled cast
--    while the round is `closed`, with no deferred target.
--  * Compelled Reaction holders cast in the Layer-0 Reaction Window and
--    cannot pass it. Skipped by vote or by the stall backstop, they Forfeit.
--  * Forfeit: the card goes back to the deck and a no-effect `forfeit` row
--    records it, pointing at Brewmageddon. Triggers: no legal target (Action
--    cards when the set is fixed, Reaction cards when the window opens); the
--    stall clock (forfeit_stalled_compelled_casts, its own branch); exclusion
--    for never rolling; being skipped in the Reaction Window.
--  * Brewmageddon countered: casts already made stand, and whoever still owes
--    a cast is released (_compelled_outstanding reads the live negation).
--
-- Resolver-pipeline functions (close_round, cast_spell_card,
-- cast_reaction_spell_card, advance_layer, _layer_is_complete,
-- _rr_resolve_eval, get_round_recap) change in db/sql/functions/ and land in
-- the generated migration that follows this one. The functions below are the
-- new helpers plus re-emits of single-definition functions that stay here.

-- ---------------------------------------------------------------------------
-- 1. Effect kinds: `compel_cast` (Brewmageddon) and `forfeit` (the Cast Log
--    row a Forfeit leaves). Neither is ever an active effect.
-- ---------------------------------------------------------------------------
alter table public.spell_card_effects drop constraint spell_card_effects_effect_kind_check;
alter table public.spell_card_effects add constraint spell_card_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'roll_pair_transform', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect', 'targeting_skip', 'per_round_dice_tick',
    'card_heist', 'compel_cast'
  ));

alter table public.spell_casts drop constraint spell_casts_effect_kind_check;
alter table public.spell_casts add constraint spell_casts_effect_kind_check
  check (effect_kind is null or effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'roll_pair_transform', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect', 'targeting_skip', 'per_round_dice_tick',
    'card_heist', 'compel_cast', 'forfeit'
  ));

-- ---------------------------------------------------------------------------
-- 2. Brewmageddon's effect row. TABLE + a kind the generic cast loop does not
--    fan out, so cast_spell_card writes one row with no target.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select id, 'TABLE', 'compel_cast', '{}'::jsonb, 0
  from public.spell_cards
 where name = 'Brewmageddon'
   and not exists (
     select 1 from public.spell_card_effects e
      where e.card_id = spell_cards.id and e.effect_kind = 'compel_cast'
   );

-- ---------------------------------------------------------------------------
-- 3. Helpers.
-- ---------------------------------------------------------------------------

-- Whether a Brewmageddon cast is negated right now: its own flag (a
-- resolved round), or a live, successful, un-countered contested_negate on
-- its cast group in the reaction stack (the same derivation resolve_round
-- Phase 1 applies, read before the round resolves).
create or replace function public._rr_brewmageddon_negated(p_cast_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select negated from public.spell_casts where id = p_cast_id), false)
      or exists (
        select 1
          from public.spell_casts bm
          cross join lateral public._rr_cast_log_resolution(bm.round_id) r
         where bm.id = p_cast_id
           and r.victim_group = bm.card_instance_id
           and r.counter_kind = 'contested_negate'
           and r.counter_succeeded
           and not r.counter_negated
           and not r.counter_backfired
      );
$$;

revoke execute on function public._rr_brewmageddon_negated(uuid) from public, anon, authenticated;

-- The compelled casts still owed in a round: every entry of a live
-- Brewmageddon's fixed set with no row yet made from that card instance by
-- that holder pointing back at it (a compelled cast or a forfeit). Empty
-- once Brewmageddon is negated -- its pending holders are released.
create or replace function public._compelled_outstanding(p_round_id uuid)
returns table (
  player_id text, card_instance_id uuid, casting_time text, brewmageddon_cast_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select h ->> 'player_id', (h ->> 'card_instance_id')::uuid, h ->> 'casting_time', bm.id
    from public.spell_casts bm
    cross join lateral jsonb_array_elements(coalesce(bm.cast_inputs -> 'compelled', '[]'::jsonb)) h
   where bm.round_id = p_round_id
     and bm.effect_kind = 'compel_cast'
     and not exists (
       select 1 from public.spell_casts c
        where c.round_id = p_round_id
          and c.caster_id = h ->> 'player_id'
          and c.card_instance_id = (h ->> 'card_instance_id')::uuid
          and c.cast_inputs ->> 'compelled_by' = bm.id::text
     )
     and not public._rr_brewmageddon_negated(bm.id);
$$;

revoke execute on function public._compelled_outstanding(uuid) from public, anon, authenticated;
grant execute on function public._compelled_outstanding(uuid) to service_role;

-- Whether a compelled holder's card has any legal target in this round. The
-- rules mirror what cast_spell_card / cast_reaction_spell_card /
-- end_active_effect would accept; a card with no cast path at all (an Action
-- CARD-target card other than a Detox) has no legal target either.
create or replace function public._compelled_card_has_legal_target(
  p_round_id uuid, p_player_id text, p_card_instance_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_card_id uuid;
  v_name text;
  v_casting_time text;
  v_target text;
  v_others integer;
  v_dispel_params jsonb;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  select sc.id, sc.name, sc.casting_time, sc.target
    into v_card_id, v_name, v_casting_time, v_target
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.id = p_card_instance_id;

  select count(*) into v_others
    from public.round_participants
   where round_id = p_round_id and player_id <> p_player_id and excluded_at is null;

  if v_casting_time = 'R' then
    if v_target = 'CARD' then
      -- Another player's cast to answer. Brewmageddon itself always is one.
      return exists (
        select 1 from public.spell_casts c
         where c.round_id = p_round_id and c.caster_id <> p_player_id
           and c.effect_kind is distinct from 'forfeit'
      );
    elsif v_target = 'OPPONENT' then
      return v_others >= 1;
    end if;
    return v_target in ('SELF', 'PLAYER', 'TABLE');
  end if;

  -- A Detox (dispel) needs an active effect of a tier it can end.
  select e.effect_params into v_dispel_params
    from public.spell_card_effects e
   where e.card_id = v_card_id and e.effect_kind = 'dispel'
   limit 1;
  if v_dispel_params is not null then
    return exists (
      select 1
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
        join public.spell_cards sc2 on sc2.id = sae.card_id
       where sc2.tier in (select jsonb_array_elements_text(v_dispel_params -> 'tiers'))
    );
  end if;

  if v_name = 'Stir the Pot' then
    return v_others >= 2;
  end if;

  if v_name = 'Tea Heist' then
    -- Only a player holding a card can be robbed (get_heist_targets /
    -- cast_spell_card's RFB53 check). Other compelled Action holders still
    -- hold theirs when the set is fixed.
    return exists (
      select 1 from public.round_participants rp
       where rp.round_id = p_round_id and rp.player_id <> p_player_id
         and rp.excluded_at is null
         and exists (
           select 1 from public.spell_deck_instances sdi
            where sdi.held_by_player = rp.player_id and sdi.location = 'held'
         )
    );
  end if;

  if v_name = 'Genie in the Teapot' then
    -- Any card Genie could name: mirrors cast_spell_card's Genie checks
    -- (keep the by-name list in sync with it).
    return exists (
      select 1
        from public.spell_cards sc
        join public.spell_deck_instances sdi on sdi.card_id = sc.id
       where sdi.location = 'in_deck'
         and sc.casting_time = 'A'
         and sc.tier <> 'epic'
         and sc.target <> 'WILD'
         and sc.name not in (
           'Genie in the Teapot', 'Bes-Tea', 'Tea Leaf', 'Spillage', 'Chai-nge of Heart',
           'Bitter Leech', 'Wild Brew Surge', 'Kettle Crash')
         and exists (
           select 1 from public.spell_card_effects e
            where e.card_id = sc.id and e.target_role <> 'WILD')
    );
  end if;

  if v_target = 'OPPONENT' then
    return v_others >= 1;
  end if;
  return v_target in ('SELF', 'PLAYER', 'CHOSEN_PLAYERS', 'TABLE', 'WILD');
end;
$$;

revoke execute on function public._compelled_card_has_legal_target(uuid, text, uuid) from public, anon, authenticated;

-- Forfeit a player's outstanding compelled cast: the card goes back to the
-- deck as if played, and a no-effect `forfeit` row points at Brewmageddon.
-- Returns false when the player owes nothing (already cast, or released).
create or replace function public._forfeit_compelled_card(
  p_round_id uuid, p_player_id text, p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  select o.card_instance_id, o.casting_time, o.brewmageddon_cast_id
    into v_owed
    from public._compelled_outstanding(p_round_id) o
   where o.player_id = p_player_id
   limit 1;

  if not found then
    return false;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_owed.card_instance_id
     and held_by_player = p_player_id
     and location = 'held';

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id,
    effect_kind, effect_params, cast_inputs
  )
  values (
    p_round_id, p_player_id, v_owed.card_instance_id, p_player_id,
    'forfeit', '{}'::jsonb,
    jsonb_build_object(
      'compelled_by', v_owed.brewmageddon_cast_id,
      'casting_time', v_owed.casting_time,
      'reason', p_reason)
  );

  return true;
end;
$$;

revoke execute on function public._forfeit_compelled_card(uuid, text, text) from public, anon, authenticated;

-- close_round's TABLE / ALL_OTHER_PLAYERS placeholder fan-out, lifted out of
-- it unchanged (0083) so a compelled cast made after close can fan its own
-- placeholders out against the final roster. p_card_instance_id null fans out
-- every placeholder in the round (close_round); otherwise only that cast's.
create or replace function public._fan_out_table_placeholder_casts(
  p_round_id uuid, p_card_instance_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_placeholder record;
  v_participant record;
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_card_id uuid;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  for v_placeholder in
    select id, caster_id, effect_kind, effect_params, card_instance_id, target_role
      from public.spell_casts
     where round_id = p_round_id
       and target_pending = true
       and target_player_id is null
       and target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
       and (p_card_instance_id is null or card_instance_id = p_card_instance_id)
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
      v_cast_inputs := null;

      if v_placeholder.effect_kind = 'dice_modifier' then
        v_dice_count := (regexp_match(v_placeholder.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
        v_dice_sides := (regexp_match(v_placeholder.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;

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
        p_round_id, v_placeholder.caster_id, v_placeholder.card_instance_id, v_participant.player_id, false,
        v_placeholder.effect_kind, v_placeholder.effect_params, v_cast_inputs, v_placeholder.target_role
      );

      perform public.record_active_effect_if_persistent(
        v_room_id, v_placeholder.caster_id, v_participant.player_id, v_card_id,
        v_placeholder.effect_kind, v_placeholder.effect_params, v_placeholder.id
      );
    end loop;
  end loop;
end;
$$;

revoke execute on function public._fan_out_table_placeholder_casts(uuid, uuid) from public, anon, authenticated;

-- Fix the compelled set of every Brewmageddon cast in the round (called by
-- close_round once the roster is locked), then forfeit each compelled Action
-- card with no legal target. A Reaction card's target is checked when the
-- Layer-0 window opens instead (_forfeit_untargetable_compelled_reactions).
create or replace function public._fix_compelled_set(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  update public.spell_casts bm
     set cast_inputs = coalesce(bm.cast_inputs, '{}'::jsonb) || jsonb_build_object(
           'compelled', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'player_id', rp.player_id,
                      'card_instance_id', sdi.id,
                      'casting_time', sc.casting_time)
                    order by rp.player_id)
               from public.round_participants rp
               join public.spell_deck_instances sdi
                 on sdi.held_by_player = rp.player_id and sdi.location = 'held'
               join public.spell_cards sc on sc.id = sdi.card_id
              where rp.round_id = p_round_id and rp.excluded_at is null
           ), '[]'::jsonb))
   where bm.round_id = p_round_id
     and bm.effect_kind = 'compel_cast'
     and not bm.negated;

  for v_owed in
    select o.player_id, o.card_instance_id
      from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
  loop
    if not public._compelled_card_has_legal_target(p_round_id, v_owed.player_id, v_owed.card_instance_id) then
      perform public._forfeit_compelled_card(p_round_id, v_owed.player_id, 'no_legal_target');
    end if;
  end loop;
end;
$$;

revoke execute on function public._fix_compelled_set(uuid) from public, anon, authenticated;

-- Forfeit each compelled Reaction card with no legal target. advance_layer
-- calls this just before it opens the Layer-0 window.
create or replace function public._forfeit_untargetable_compelled_reactions(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  for v_owed in
    select o.player_id, o.card_instance_id
      from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'R'
  loop
    if not public._compelled_card_has_legal_target(p_round_id, v_owed.player_id, v_owed.card_instance_id) then
      perform public._forfeit_compelled_card(p_round_id, v_owed.player_id, 'no_legal_target');
    end if;
  end loop;
end;
$$;

revoke execute on function public._forfeit_untargetable_compelled_reactions(uuid) from public, anon, authenticated;

-- The tail every cast path runs before returning: when the cast just made
-- meets a compelled obligation, fan out its TABLE placeholders (a cast made
-- after close_round missed the close-time fan-out) and tag every row of it
-- with cast_inputs.compelled_by, which both meets the obligation and links
-- the cast to Brewmageddon in the Recap. A no-op for any other cast.
create or replace function public._rr_finish_compelled_cast(
  p_round_id uuid, p_player_id text, p_card_instance_id uuid, p_cast_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brewmageddon_cast_id uuid;
begin
  select o.brewmageddon_cast_id into v_brewmageddon_cast_id
    from public._compelled_outstanding(p_round_id) o
   where o.player_id = p_player_id and o.card_instance_id = p_card_instance_id;

  if v_brewmageddon_cast_id is null then
    return p_cast_id;
  end if;

  perform public._fan_out_table_placeholder_casts(p_round_id, p_card_instance_id);

  update public.spell_casts
     set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                       || jsonb_build_object('compelled_by', v_brewmageddon_cast_id)
   where round_id = p_round_id
     and card_instance_id = p_card_instance_id
     and caster_id = p_player_id;

  return p_cast_id;
end;
$$;

revoke execute on function public._rr_finish_compelled_cast(uuid, text, uuid, uuid) from public, anon, authenticated;

-- Whether the caller has a compelled Action cast to make now (the Compelled
-- Cast step). cast_spell_card and end_active_effect read this to accept a
-- cast while the round is closed.
create or replace function public._owes_compelled_action_cast(p_round_id uuid, p_player_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.player_id = p_player_id and o.casting_time = 'A'
  );
$$;

revoke execute on function public._owes_compelled_action_cast(uuid, text) from public, anon, authenticated;

-- Whether the Compelled Cast step is still holding rolling: some compelled
-- Action cast is still owed.
create or replace function public._compelled_cast_step_open(p_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
  );
$$;

revoke execute on function public._compelled_cast_step_open(uuid) from public, anon, authenticated;
grant execute on function public._compelled_cast_step_open(uuid) to service_role;

-- The caller's own outstanding compelled cast, for the prompt: which card,
-- whether it is an Action (cast now) or a Reaction (cast in the window), and
-- who played Brewmageddon. No row when the caller owes nothing.
create or replace function public.get_my_compelled_cast(p_round_id uuid)
returns table (casting_time text, card_name text, brewmageddon_caster_id text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select o.casting_time, sc.name, bm.caster_id
      from public._compelled_outstanding(p_round_id) o
      join public.spell_deck_instances sdi on sdi.id = o.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
      join public.spell_casts bm on bm.id = o.brewmageddon_cast_id
     where o.player_id = v_player_id;
end;
$$;

revoke execute on function public.get_my_compelled_cast(uuid) from public, anon;
grant execute on function public.get_my_compelled_cast(uuid) to authenticated;

-- The Compelled Cast step as the table sees it: who still owes an Action
-- cast (rolling is held while this is non-empty), and when the step ended --
-- the last compelled Action cast or Forfeit -- or null when the round had no
-- step. Layer 0's roll stall clock runs from ended_at when there is one, so
-- a long step never counts against the rollers.
create or replace function public.get_compelled_cast_step(p_round_id uuid)
returns table (waiting_on text[], ended_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(array(
      select o.player_id from public._compelled_outstanding(p_round_id) o
       where o.casting_time = 'A'
       order by o.player_id), '{}'::text[]),
    (select max(c.cast_at)
       from public.spell_casts c
      where c.round_id = p_round_id
        and c.reaction_window_id is null
        and c.cast_inputs ? 'compelled_by'
        and (c.effect_kind is distinct from 'forfeit' or c.cast_inputs ->> 'casting_time' = 'A'));
$$;

revoke execute on function public.get_compelled_cast_step(uuid) from public, anon;
grant execute on function public.get_compelled_cast_step(uuid) to authenticated;

-- The stall clock's Compelled Cast branch: forfeits every compelled Action
-- cast still owed, which ends the step and lets rolling open. Returns who
-- forfeited. enforceStallTimeout (src/app/rounds/stallEnforcement.ts)
-- decides that STALL_TIMEOUT_MS has passed before calling this, like every
-- other stall RPC.
create or replace function public.forfeit_stalled_compelled_casts(p_round_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_forfeited text[] := '{}';
  v_player_id text;
begin
  perform 1 from public.rounds where id = p_round_id for update;

  for v_player_id in
    select o.player_id from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
     order by o.player_id
  loop
    if public._forfeit_compelled_card(p_round_id, v_player_id, 'stall') then
      v_forfeited := v_forfeited || v_player_id;
    end if;
  end loop;

  return v_forfeited;
end;
$$;

revoke execute on function public.forfeit_stalled_compelled_casts(uuid) from public, anon;
grant execute on function public.forfeit_stalled_compelled_casts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Re-emits of single-definition functions.
-- ---------------------------------------------------------------------------

-- Rolling is held during the Compelled Cast step: nobody is an expected
-- Layer-0 roller until every compelled Action cast is in. This is the gate
-- submit_roll, submit_manual_roll and the Test Room roll-as RPCs all check,
-- and page.tsx reads it for "your turn to roll". Otherwise unchanged (0014).
create or replace function public.is_expected_layer_roller(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 and public._compelled_cast_step_open(p_round_id) then
    return false;
  end if;

  return exists (
    select 1 from public.get_expected_layer_roller_ids(p_round_id, p_layer) ids
     where ids.player_id = p_player_id
  );
end;
$$;

-- Exclusion for never rolling forfeits the player's outstanding compelled
-- cast (a Reaction holder who never rolled never reached the window).
-- Otherwise unchanged (0009).
create or replace function public.exclude_round_participant(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 then
    update public.round_participants
       set excluded_at = now()
     where round_id = p_round_id and player_id = p_player_id and excluded_at is null;

    perform public._forfeit_compelled_card(p_round_id, p_player_id, 'excluded');
  else
    update public.round_layer_participants
       set excluded_at = now()
     where round_id = p_round_id and layer = p_layer and player_id = p_player_id
       and excluded_at is null;
  end if;
end;
$$;

-- A compelled Reaction holder cannot pass the Layer-0 window: they must cast
-- (or be skipped, which forfeits). Released holders (Brewmageddon countered)
-- pass as normal. Otherwise unchanged (0064).
create or replace function public.pass_reaction_window(p_round_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_poll_round integer;
  v_eligible_count integer;
  v_passed_count integer;
  v_closed boolean := false;
begin
  v_player_id := public.current_player_id();

  select id, poll_round into v_window_id, v_poll_round
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'pass_reaction_window: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  if exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.player_id = v_player_id and o.casting_time = 'R'
  ) then
    raise exception 'pass_reaction_window: Brewmageddon compels you to play your card'
      using errcode = 'RFB55';
  end if;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id)
  values (v_window_id, v_poll_round, v_player_id)
  on conflict (window_id, poll_round, player_id) do nothing;

  v_eligible_count := public.count_eligible_reaction_holders(p_round_id);

  select count(*) into v_passed_count
    from public.spell_reaction_passes p
    join public.spell_deck_instances sdi on sdi.held_by_player = p.player_id
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.round_participants rp on rp.player_id = sdi.held_by_player
   where p.window_id = v_window_id and p.poll_round = v_poll_round
     and sdi.location = 'held' and sc.casting_time = 'R' and rp.round_id = p_round_id;

  if v_passed_count >= v_eligible_count then
    perform public.close_reaction_window(v_window_id);
    v_closed := true;
  end if;

  return v_closed;
end;
$$;

-- Skipped by the Skip vote or the stall backstop: a compelled Reaction holder
-- Forfeits instead of keeping the card (decided when #440 was ticketed). The
-- auto-pass rows are still written, so the Recap still names who wasn't
-- heard from. Otherwise unchanged (0114).
create or replace function public._auto_pass_reaction_window(
  p_round_id uuid, p_window_id uuid, p_reason text
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_round integer;
  v_players text[];
  v_player_id text;
begin
  select poll_round into v_poll_round
    from public.spell_reaction_windows
   where id = p_window_id;

  select coalesce(array_agg(w order by w), '{}')
    into v_players
    from public._reaction_window_waiting_on(p_round_id, p_window_id, v_poll_round) w;

  foreach v_player_id in array v_players loop
    perform public._forfeit_compelled_card(p_round_id, v_player_id, p_reason);
  end loop;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id, reason)
  select p_window_id, v_poll_round, unnest(v_players), p_reason
  on conflict (window_id, poll_round, player_id) do nothing;

  perform public.close_reaction_window(p_window_id);
  return v_players;
end;
$$;

revoke execute on function public._auto_pass_reaction_window(uuid, uuid, text) from public, anon, authenticated;

-- A Detox (dispel) is played through its own RPC; a compelled Detox holder
-- plays it in the Compelled Cast step like any other Action card. Otherwise
-- unchanged (0084).
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

  select sae.target_player_id, sc2.tier, sae.room_id
    into v_target_player_id, v_target_tier, v_target_room_id
    from public.spell_active_effects sae
    join public.spell_cards sc2 on sc2.id = sae.card_id
   where sae.id = p_effect_id;

  if v_target_player_id is null then
    raise exception 'end_active_effect: active effect not found';
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

-- Nobody rolls during the Compelled Cast step, a Proxy Roll included.
-- Otherwise unchanged (0071).
create or replace function public.admin_proxy_roll(p_round_id uuid, p_player_id text, p_value integer)
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
    raise exception 'admin_proxy_roll: value must be between 1 and 20';
  end if;

  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_proxy_roll: caller is not an admin';
  end if;

  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'admin_proxy_roll: target player not found';
  end if;

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'admin_proxy_roll: round not found';
  end if;

  if v_status not in ('open', 'closed') or exists (
    select 1 from public.rolls where round_id = p_round_id
  ) then
    raise exception 'admin_proxy_roll: round is no longer open for a proxy roll'
      using errcode = 'RFB32';
  end if;

  if v_status = 'closed' and public._compelled_cast_step_open(p_round_id) then
    raise exception 'admin_proxy_roll: rolling is held until every compelled cast is in'
      using errcode = 'RFB54';
  end if;

  -- Implicitly creates the target's today's-room membership — no prior
  -- login required, unlike every other room_players writer
  -- (enter_todays_room, 0003) which always derives the player from the
  -- authenticated caller.
  insert into public.room_players (room_id, player_id)
  values (v_room_id, p_player_id)
  on conflict (room_id, player_id) do nothing;

  insert into public.round_participants (round_id, player_id)
  values (p_round_id, p_player_id)
  on conflict (round_id, player_id) do nothing;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = p_player_id;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, entered_by_admin)
  values (p_round_id, p_player_id, v_layer, p_value, 'manual', v_modifier, true);

  -- Same nat-1/nat-20 pending-draw trigger submit_roll/submit_manual_roll
  -- get via maybeRecordPendingSpellDraw (roundActionHelpers.ts), but
  -- inserted directly for the target player rather than reused via
  -- record_pending_spell_draw (0036) — that RPC resolves its player from
  -- current_player_id(p_round_id), which would credit the admin's own
  -- identity, not the proxied player's.
  if p_value in (1, 20) then
    insert into public.pending_spell_draws (round_id, player_id, trigger)
    values (p_round_id, p_player_id, case when p_value = 1 then 'nat1' else 'nat20' end)
    on conflict (round_id, player_id) do nothing;
  end if;
end;
$$;

-- The reaction stack also carries the round's Brewmageddon cast while a
-- window is open: it is always a legal CARD target (#385), and a compelled
-- CARD-target Reaction holder must be able to pick it even when no cast is
-- attached to the window. Otherwise unchanged (0021).
create or replace function public.get_reaction_stack(p_round_id uuid)
returns table (
  cast_id uuid, card_name text, caster_id text, caster_name text,
  target_stamp text, negated boolean, parent_cast_id uuid, seq bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select casts.id, sc.name, casts.caster_id, coalesce(p.display_name, p.email),
      sc.target, casts.negated, casts.parent_cast_id, casts.seq
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
      join public.players p on p.id = casts.caster_id
      left join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where (w.round_id = p_round_id and w.status = 'open')
        or (casts.round_id = p_round_id
            and casts.effect_kind = 'compel_cast'
            and exists (
              select 1 from public.spell_reaction_windows ow
               where ow.round_id = p_round_id and ow.status = 'open'))
     order by casts.seq asc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Un-bench Brewmageddon (benched by 0074 for having no effect rows).
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck'
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Brewmageddon'
   and sdi.location = 'benched';
