-- The eager shim records before->after roll values; resolve_round adopts
-- them (issue #306, third implementation slice of the effect-application
-- rebuild #302 / ADR 0005).
--
-- Migration number: master's highest is 0077 (0077_cast_log_schema_expand);
-- the rebuild branch adds 0078 (resolve_round authoritative, #305). This is
-- 0079. Re-check at the integrate step (branching strategy in #303) and
-- renumber to sit after master's current highest.
--
-- What changes
-- ------------
-- The four roll-INPUT-mutating spell kinds -- advantage / disadvantage
-- (at submit_roll), forced_reroll / roll_flip / roll_swap (at
-- reaction-window finalize) -- keep doing exactly what they did to the
-- rolls table (so RoundReveal / round history / the reveal broadcast are
-- byte-for-byte unchanged), but now ALSO record their exact per-player
-- before->after into spell_casts.cast_inputs under the key `roll_transform`.
--
--   cast_inputs -> 'roll_transform' = {
--     "kind":      <effect_kind>,
--     "order":     1 advantage/disadvantage | 2 forced_reroll | 3 roll_flip
--                  | 4 roll_swap  -- the fixed resolution order, "flip
--                  before swap" being the documented tie of record for a
--                  player hit by both,
--     "cancelled": <bool>            -- advantage/disadvantage only: both
--                                       kinds on one player cancel to a
--                                       single unmodified d20,
--     "dice":      [<d20>, <d20>?],  -- advantage/disadvantage only,
--     "players":   [ { "player_id": <text>, "before": <int>, "after": <int> }, ... ]
--   }
--
-- resolve_round(uuid) gains a Phase 3 (roll-input accounting): it rebuilds
-- every layer-0 roller's final roll value PURELY from the recorded
-- `roll_transform` entries -- walking them in (order, seq) and adopting the
-- last `after` -- with no dependence on the live-mutated rolls.value, and
-- emits one Resolution Trace step per recorded entry with a typed
-- before->after roll value (type = 'roll'). A player with no recorded
-- transform keeps their loaded rolls.value (their unmodified roll). This is
-- what lets a later slice (#307/#308) do counterspell "logical unwind" for
-- an already-executed eager effect: drop the negated cast's entries and
-- re-walk.
--
-- rolls.value stays mutated in place by the apply_* RPCs and is now a
-- resolver-agreeing cache (like spell_casts.negated): the shim's recorded
-- `after` and the mutated rolls.value must always match. The declared-number
-- brewer pick and get_round_modifier_effects still read rolls.value /
-- resolved_value directly, so keeping both in sync keeps every non-#306
-- path behaviour-identical.
--
-- Pending Spell Die (issue #252): the unrolled sentinel moves from
-- `spell_casts.resolved_value IS NULL` to `NOT (cast_inputs ? 'dice_roll')`.
-- resolve_pending_spell_die_in_app / _manual / resolve_stalled_pending_spell_dice
-- now ALSO write `cast_inputs.dice_roll` (the raw, unsigned dice total --
-- the sign is applied by whoever reads it), keeping resolved_value written
-- in parallel for the legacy readers (get_round_modifier_effects,
-- spellCasts.ts) until #312 de-overloads it. resolve_round Phase 4a reads
-- cast_inputs.dice_roll when present, falling back to resolved_value.

-- ===========================================================================
-- 1. submit_roll / submit_roll_as -- record advantage / disadvantage
-- ===========================================================================
-- Behaviour vs 0060: the kept value, the discarded value, and the rolls
-- insert are UNCHANGED. The only addition is the cast_inputs.roll_transform
-- write onto the advantage / disadvantage cast row(s) that targeted this
-- player. When both kinds target the same player they cancel (one d20, no
-- second draw) and both rows record `cancelled: true` with before == after.

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
  v_has_advantage boolean;
  v_has_disadvantage boolean;
  v_cancelled boolean;
  v_dice jsonb;
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
  v_first_value := v_value;
  v_discarded_value := null;
  v_cancelled := v_has_advantage and v_has_disadvantage;

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

  -- Record the roll transform onto the advantage / disadvantage cast(s).
  if v_has_advantage or v_has_disadvantage then
    if v_cancelled then
      v_dice := jsonb_build_array(v_first_value);
    elsif v_second_value is not null then
      v_dice := jsonb_build_array(v_first_value, v_second_value);
    else
      v_dice := jsonb_build_array(v_first_value);
    end if;

    update public.spell_casts casts
       set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', casts.effect_kind,
               'order', 1,
               'cancelled', v_cancelled,
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
       and casts.effect_kind in ('advantage', 'disadvantage');
  end if;

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
  v_first_value integer;
  v_second_value integer;
  v_discarded_value integer;
  v_has_advantage boolean;
  v_has_disadvantage boolean;
  v_cancelled boolean;
  v_dice jsonb;
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
  v_first_value := v_value;
  v_discarded_value := null;
  v_cancelled := v_has_advantage and v_has_disadvantage;

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

  if v_has_advantage or v_has_disadvantage then
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
               'players', jsonb_build_array(jsonb_build_object(
                 'player_id', p_player_id,
                 'before', v_first_value,
                 'after', v_value
               ))
             ))
     where casts.round_id = p_round_id
       and casts.target_player_id = p_player_id
       and casts.target_pending = false
       and casts.effect_kind in ('advantage', 'disadvantage');
  end if;

  return v_value;
end;
$$;

revoke execute on function public.submit_roll_as(uuid, text) from public, anon;
grant execute on function public.submit_roll_as(uuid, text) to authenticated;

-- ===========================================================================
-- 2. apply_forced_reroll -- record the before->after
-- ===========================================================================
-- Unchanged: overwrites the player's rolls.value with a fresh server d20 and
-- returns it. Added: records roll_transform (order 2) onto every un-negated
-- forced_reroll cast in this round/layer's reaction window that targets this
-- player. If there is no such cast row (a direct-RPC test), the recording
-- loop simply does nothing.

create or replace function public.apply_forced_reroll(p_round_id uuid, p_layer integer, p_player_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_value integer;
  v_value integer;
  v_cast record;
begin
  select value into v_old_value
    from public.rolls
   where round_id = p_round_id and layer = p_layer and player_id = p_player_id;

  if v_old_value is null then
    raise exception 'apply_forced_reroll: no existing roll for % at round %, layer %', p_player_id, p_round_id, p_layer;
  end if;

  v_value := floor(random() * 20 + 1)::integer;

  update public.rolls
     set value = v_value
   where round_id = p_round_id and layer = p_layer and player_id = p_player_id;

  for v_cast in
    select casts.id
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = 'forced_reroll'
       and casts.negated = false
       and casts.target_player_id = p_player_id
  loop
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', 'forced_reroll',
               'order', 2,
               'players', jsonb_build_array(jsonb_build_object(
                 'player_id', p_player_id,
                 'before', v_old_value,
                 'after', v_value
               ))
             ))
     where id = v_cast.id;
  end loop;

  return v_value;
end;
$$;

revoke execute on function public.apply_forced_reroll(uuid, integer, text) from public, anon;
grant execute on function public.apply_forced_reroll(uuid, integer, text) to authenticated;

-- ===========================================================================
-- 3. apply_roll_flip -- record every player's before->after
-- ===========================================================================
-- Unchanged: flips every roll in the layer to 21 - value in place and
-- returns the full post-flip set. Added: records roll_transform (order 3)
-- with one players[] entry per roll onto every un-negated roll_flip cast in
-- this round/layer's window.

create or replace function public.apply_roll_flip(p_round_id uuid, p_layer integer)
returns table (player_id text, value integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_players jsonb;
  v_cast record;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'player_id', r.player_id,
           'before', r.value,
           'after', 21 - r.value
         ) order by r.player_id), '[]'::jsonb)
    into v_players
    from public.rolls r
   where r.round_id = p_round_id and r.layer = p_layer;

  update public.rolls as r
     set value = 21 - r.value
   where r.round_id = p_round_id and r.layer = p_layer;

  for v_cast in
    select casts.id
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = 'roll_flip'
       and casts.negated = false
  loop
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', 'roll_flip',
               'order', 3,
               'players', v_players
             ))
     where id = v_cast.id;
  end loop;

  return query
    select r.player_id, r.value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = p_layer;
end;
$$;

revoke execute on function public.apply_roll_flip(uuid, integer) from public, anon;
grant execute on function public.apply_roll_flip(uuid, integer) to authenticated;

-- ===========================================================================
-- 4. apply_roll_swap -- record the two swapped players' before->after
-- ===========================================================================
-- Unchanged: swaps the layer's highest and lowest rolls in place and
-- returns just the two changed rows; early-returns (recording nothing) when
-- there are fewer than two distinct rollers. Added: records roll_transform
-- (order 4) for the two players onto every un-negated roll_swap cast in the
-- window.

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
  v_cast record;
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

  update public.rolls as r set value = v_low_value where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_high_player;
  update public.rolls as r set value = v_high_value where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_low_player;

  for v_cast in
    select casts.id
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = 'roll_swap'
       and casts.negated = false
  loop
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', 'roll_swap',
               'order', 4,
               'players', jsonb_build_array(
                 jsonb_build_object('player_id', v_high_player, 'before', v_high_value, 'after', v_low_value),
                 jsonb_build_object('player_id', v_low_player, 'before', v_low_value, 'after', v_high_value)
               )
             ))
     where id = v_cast.id;
  end loop;

  return query
    select v_high_player, v_low_value
    union all
    select v_low_player, v_high_value;
end;
$$;

revoke execute on function public.apply_roll_swap(uuid, integer) from public, anon;
grant execute on function public.apply_roll_swap(uuid, integer) to authenticated;

-- ===========================================================================
-- 5. Pending Spell Die -- cast_inputs ? 'dice_roll' is the new sentinel
-- ===========================================================================

-- get_current_layer_rolls_if_complete: layer 0 isn't "complete" while any
-- dice_modifier cast is still unrolled -- now keyed off cast_inputs. This
-- also restores the layer-0 pending-die gate that 0069 added and 0071
-- (which drop+recreated this function to widen it with entered_by_admin)
-- inadvertently dropped. Signature matches 0071.
drop function if exists public.get_current_layer_rolls_if_complete(uuid);
create function public.get_current_layer_rolls_if_complete(p_round_id uuid)
returns table (
  layer integer,
  player_id text,
  value integer,
  modifier_snapshot integer,
  discarded_value integer,
  entered_by_admin boolean
)
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
     where round_id = p_round_id and effect_kind = 'dice_modifier'
       and not coalesce(cast_inputs ? 'dice_roll', false)
  ) then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot, r.discarded_value, r.entered_by_admin
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_current_layer_rolls_if_complete(uuid) from public, anon;
grant execute on function public.get_current_layer_rolls_if_complete(uuid) to authenticated;

drop function if exists public.get_completed_layer_rolls_for_stall_resolution(uuid);
create function public.get_completed_layer_rolls_for_stall_resolution(p_round_id uuid)
returns table (
  layer integer,
  player_id text,
  value integer,
  modifier_snapshot integer,
  discarded_value integer,
  entered_by_admin boolean
)
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
     where round_id = p_round_id and effect_kind = 'dice_modifier'
       and not coalesce(cast_inputs ? 'dice_roll', false)
  ) then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot, r.discarded_value, r.entered_by_admin
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) from public, anon;
grant execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) to authenticated;

-- get_my_pending_spell_dice: the caller's own still-unrolled dice.
create or replace function public.get_my_pending_spell_dice(p_round_id uuid)
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
       and not coalesce(casts.cast_inputs ? 'dice_roll', false)
     order by casts.cast_at asc;
end;
$$;

revoke execute on function public.get_my_pending_spell_dice(uuid) from public, anon;
grant execute on function public.get_my_pending_spell_dice(uuid) to authenticated;

-- resolve_pending_spell_die_in_app: server-rolls the die. Writes BOTH
-- cast_inputs.dice_roll (raw, unsigned -- the new sentinel + source of
-- truth) and resolved_value (signed -- the legacy cache).
create or replace function public.resolve_pending_spell_die_in_app(p_cast_id uuid)
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

  v_player_id := public.current_player_id(v_row.round_id);

  if v_row.target_player_id <> v_player_id then
    raise exception 'resolve_pending_spell_die_in_app: only the affected player can resolve this die';
  end if;

  if v_row.effect_kind <> 'dice_modifier' or coalesce(v_row.cast_inputs ? 'dice_roll', false) then
    raise exception 'resolve_pending_spell_die_in_app: this cast has no pending die to resolve';
  end if;

  v_dice_count := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
  v_dice_sides := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
  v_dice_sign := coalesce((v_row.effect_params ->> 'sign')::integer, 1);

  v_roll_total := 0;
  for i in 1..v_dice_count loop
    v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
  end loop;

  update public.spell_casts
     set resolved_value = v_roll_total * v_dice_sign,
         cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object('dice_roll', v_roll_total)
   where id = p_cast_id;

  return v_roll_total;
end;
$$;

revoke execute on function public.resolve_pending_spell_die_in_app(uuid) from public, anon;
grant execute on function public.resolve_pending_spell_die_in_app(uuid) to authenticated;

create or replace function public.resolve_pending_spell_die_manual(p_cast_id uuid, p_value integer)
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

  v_player_id := public.current_player_id(v_row.round_id);

  if v_row.target_player_id <> v_player_id then
    raise exception 'resolve_pending_spell_die_manual: only the affected player can resolve this die';
  end if;

  if v_row.effect_kind <> 'dice_modifier' or coalesce(v_row.cast_inputs ? 'dice_roll', false) then
    raise exception 'resolve_pending_spell_die_manual: this cast has no pending die to resolve';
  end if;

  v_dice_count := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
  v_dice_sides := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
  v_dice_sign := coalesce((v_row.effect_params ->> 'sign')::integer, 1);

  if p_value is null or p_value < v_dice_count or p_value > v_dice_count * v_dice_sides then
    raise exception 'resolve_pending_spell_die_manual: value must be between % and %', v_dice_count, v_dice_count * v_dice_sides;
  end if;

  update public.spell_casts
     set resolved_value = p_value * v_dice_sign,
         cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object('dice_roll', p_value)
   where id = p_cast_id;
end;
$$;

revoke execute on function public.resolve_pending_spell_die_manual(uuid, integer) from public, anon;
grant execute on function public.resolve_pending_spell_die_manual(uuid, integer) to authenticated;

create or replace function public.resolve_stalled_pending_spell_dice(p_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cast record;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
  v_resolved_count integer := 0;
begin
  for v_cast in
    select id, effect_params from public.spell_casts
     where round_id = p_round_id and effect_kind = 'dice_modifier'
       and not coalesce(cast_inputs ? 'dice_roll', false)
       for update
  loop
    v_dice_count := (regexp_match(v_cast.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
    v_dice_sides := (regexp_match(v_cast.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
    v_dice_sign := coalesce((v_cast.effect_params ->> 'sign')::integer, 1);

    v_roll_total := 0;
    for i in 1..v_dice_count loop
      v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
    end loop;

    update public.spell_casts
       set resolved_value = v_roll_total * v_dice_sign,
           cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object('dice_roll', v_roll_total)
     where id = v_cast.id;
    v_resolved_count := v_resolved_count + 1;
  end loop;

  return v_resolved_count;
end;
$$;

revoke execute on function public.resolve_stalled_pending_spell_dice(uuid) from public, anon;
grant execute on function public.resolve_stalled_pending_spell_dice(uuid) to authenticated;

-- ===========================================================================
-- 6. resolve_round(uuid) -- Phase 3 roll-input accounting + Phase 4a dice
-- ===========================================================================
-- Full redefinition of the 0078 function. The ONLY changes vs 0078:
--   * new Phase 3 block (between loading the layer-0 rollers and Phase 4a):
--     rebuilds v_rolls[] purely from cast_inputs.roll_transform and emits a
--     Trace step per recorded entry with type = 'roll';
--   * Phase 4a's spell_casts union arm carries cast_inputs, and the
--     dice_modifier flat is taken from cast_inputs.dice_roll (raw) * sign
--     when present, falling back to resolved_value.
-- Everything else is byte-for-byte 0078.

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

  v_row record;
  v_el jsonb;
  v_pid text;
  v_i integer;
  v_local_idx integer;
  v_before numeric;
  v_after numeric;
  v_running numeric;

  v_has_lghm boolean := false;
  v_lghm_cast record;
  v_high_roll_composed numeric;
  v_lowest_roll integer;

  v_override record;
  v_declared record;
begin
  select status, room_id, current_layer
    into v_status, v_room_id, v_layer
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
  -- Phase 3: roll-input accounting (issue #306).
  --
  -- The eager shim (advantage / disadvantage at submit_roll;
  -- forced_reroll / roll_flip / roll_swap at reaction-window finalize)
  -- recorded each cast's exact per-player before->after into
  -- cast_inputs.roll_transform. Rebuild every roller's final roll value
  -- from those recorded entries ALONE -- walked in (order, seq), where
  -- order is 1 advantage/disadvantage < 2 forced_reroll < 3 roll_flip <
  -- 4 roll_swap ("flip before swap" is the documented tie) -- so the
  -- resolver never depends on the live-mutated rolls.value. A roller with
  -- no recorded transform keeps their loaded value. One Trace step per
  -- recorded entry, typed before->after roll value.
  -- ------------------------------------------------------------------
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_running := null;

    for v_row in
      select casts.id as cast_id,
             casts.seq as seq,
             casts.caster_id as caster_id,
             casts.effect_kind as kind,
             sc.name as card_name,
             (rt.rt ->> 'order')::integer as ord,
             (pe.value ->> 'before')::numeric as p_before,
             (pe.value ->> 'after')::numeric as p_after
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
        cross join lateral (select casts.cast_inputs -> 'roll_transform' as rt) rt
        cross join lateral jsonb_array_elements(rt.rt -> 'players') as pe(value)
       where casts.round_id = p_round_id
         and casts.negated = false
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap')
         and casts.cast_inputs ? 'roll_transform'
         and pe.value ->> 'player_id' = v_pid
       order by (rt.rt ->> 'order')::integer, casts.seq
    loop
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

    if v_running is not null then
      v_rolls[v_i] := v_running::integer;
    end if;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 4a: gather modifier-bucket effects, normalise, bucket per
  -- target player in application order (spec section 6: within a phase,
  -- spell_casts.seq ascending; spell_active_effects rows compose first,
  -- ordered among themselves by created_at).
  -- ------------------------------------------------------------------
  for v_row in
    select eff.target_player_id, eff.effect_kind, eff.effect_params, eff.resolved_value, eff.cast_inputs,
           eff.cast_id, eff.active_effect_id, eff.card_name, eff.caster_player_id, eff.ord
      from (
        select casts.target_player_id,
               casts.effect_kind,
               casts.effect_params,
               casts.resolved_value,
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
               sae.effect_kind,
               sae.effect_params,
               null::numeric as resolved_value,
               null::jsonb as cast_inputs,
               null::uuid as cast_id,
               sae.id as active_effect_id,
               sc.name as card_name,
               sae.caster_id as caster_player_id,
               null::bigint as ord,
               sae.created_at as ts
          from public.spell_active_effects sae
          join public.spell_cards sc on sc.id = sae.card_id
         where sae.room_id = v_room_id
           and sae.effect_kind in
             ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
      ) eff
     order by eff.ord asc nulls first, eff.ts asc
  loop
    -- Only effects landing on an actual layer-0 roller shape the outcome.
    if not (v_row.target_player_id = any (v_players)) then
      continue;
    end if;

    v_el := jsonb_build_object(
      'ord', coalesce(v_row.ord, 0),
      'kind', v_row.effect_kind,
      'cast_id', v_row.cast_id,
      'active_effect_id', v_row.active_effect_id,
      'card_name', v_row.card_name,
      'caster_player_id', v_row.caster_player_id,
      'target_player', v_row.target_player_id
    );

    if v_row.effect_kind = 'flat_modifier' then
      v_el := v_el || jsonb_build_object('flat', coalesce((v_row.effect_params->>'delta')::numeric, 0));
    elsif v_row.effect_kind = 'dice_modifier' then
      -- issue #306: the resolved die total lives in cast_inputs.dice_roll
      -- (raw, unsigned); the sign is applied here. resolved_value is the
      -- legacy fallback for the (dead) eager CHOSEN_PLAYERS / TABLE
      -- fan-out branches that still write only that column.
      v_el := v_el || jsonb_build_object('flat',
        case
          when v_row.cast_inputs ? 'dice_roll'
            then (v_row.cast_inputs->>'dice_roll')::numeric
                 * coalesce((v_row.effect_params->>'sign')::numeric, 1)
          else coalesce(v_row.resolved_value, 0)
        end);
    elsif v_row.effect_kind = 'modifier_multiplier' then
      v_el := v_el || jsonb_build_object('mult', coalesce((v_row.effect_params->>'multiplier')::numeric, 1));
    elsif v_row.effect_kind = 'set_modifier' then
      v_el := v_el || jsonb_build_object('set', coalesce((v_row.effect_params->>'value')::numeric, 0));
    end if;

    v_effects_json := jsonb_set(
      v_effects_json,
      array[v_row.target_player_id],
      (v_effects_json -> v_row.target_player_id) || jsonb_build_array(v_el),
      true
    );
  end loop;

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
        jsonb_build_object('type', 'modifier', 'value', v_after)
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
    select casts.id as id, casts.caster_id as caster_id, sc.name as name
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
  -- Phase 5: brewer selection. Precedence declared > override > default.
  -- ------------------------------------------------------------------
  for v_declared in
    select sae.id, (sae.effect_params->>'number')::integer as number,
           sae.caster_id, sc.name as card_name
      from public.spell_active_effects sae
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
  'Authoritative layer-0 outcome resolver (issues #305/#306, ADR 0005): rebuilds every roller''s final roll from the eager shim''s recorded cast_inputs.roll_transform (Phase 3), owns modifier composition and brewer selection (Phases 4-5), emits the Resolution Trace into rounds.resolution_trace, and returns { outcome, brewer_id, brewer_source, tied_player_ids, cups_made, no_modifier_gain, trace }. Pure over its inputs and independent of the live-mutated rolls.value. Layer > 0 bypasses all spell logic (issue #219).';
