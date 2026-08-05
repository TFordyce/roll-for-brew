-- Expose rolls.discarded_value (0049) through get_current_layer_rolls_if_complete
-- (issue #167, part of #160's RollCalculation spell-effect UI work). 0049
-- added the column and started writing it, but nothing ever read it back out
-- to the client — the struck-through discarded die in the RollCalculation
-- rework needs it alongside the kept value for the same layer's rolls.
-- Latest prior definition: 0026_acting_as_and_end_test_session.sql.
-- create or replace can't widen a function's return type (Postgres error
-- 42P13 "cannot change return type of existing function") — drop the old
-- five/four-column definitions first, same as 0050 had to for
-- get_round_modifier_effects.
drop function if exists public.get_current_layer_rolls_if_complete(uuid);

create function public.get_current_layer_rolls_if_complete(p_round_id uuid)
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

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot, r.discarded_value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_current_layer_rolls_if_complete(uuid) from public, anon;
grant execute on function public.get_current_layer_rolls_if_complete(uuid) to authenticated;

-- Same widening for the stall-timeout counterpart (0009/0012) — it returns
-- the identical CompletedLayer shape client-side (src/lib/supabase/stall.ts),
-- so both RPCs need to stay in lockstep or that shared type can't hold.
-- Same return-type-widening restriction as above — drop first.
drop function if exists public.get_completed_layer_rolls_for_stall_resolution(uuid);

create function public.get_completed_layer_rolls_for_stall_resolution(p_round_id uuid)
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

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot, r.discarded_value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) from public, anon;
grant execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) to authenticated;

-- get_round_modifier_effects (0050) returns its rows with no ORDER BY, so
-- Postgres gives no ordering guarantee at all — but classifyEffectImpact
-- (issue #166, src/lib/game/modifierBucket.ts) requires its input already in
-- "ordinal order" to make its per-effect marginal-diff call correctly. Same
-- output shape as 0050 (create or replace is safe here, no drop needed) —
-- just orders the underlying union by each row's real timestamp
-- (spell_casts.cast_at for a round's own casts, spell_active_effects.
-- created_at for a persistent effect predating the round) before dropping
-- that timestamp from the returned columns.
create or replace function public.get_round_modifier_effects(p_round_id uuid)
returns table (
  target_player_id text,
  effect_kind text,
  effect_params jsonb,
  resolved_value numeric,
  card_name text,
  caster_player_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'get_round_modifier_effects: caller is not a participant in this round';
  end if;

  select room_id into v_room_id from public.rounds where id = p_round_id;

  return query
    select t.target_player_id, t.effect_kind, t.effect_params, t.resolved_value, t.card_name, t.caster_player_id
      from (
        select casts.target_player_id, casts.effect_kind, casts.effect_params, casts.resolved_value,
               sc.name as card_name, casts.caster_id as caster_player_id, casts.cast_at as ordinal_ts
          from public.spell_casts casts
          join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
          join public.spell_cards sc on sc.id = sdi.card_id
         where casts.round_id = p_round_id
           and casts.target_pending = false
           and casts.negated = false
           and casts.effect_kind in (
             'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
             'advantage', 'disadvantage'
           )
           and sc.duration_rounds is null
        union all
        select sae.target_player_id, sae.effect_kind, sae.effect_params, null::numeric,
               sc.name as card_name, sae.caster_id as caster_player_id, sae.created_at as ordinal_ts
          from public.spell_active_effects sae
          join public.spell_cards sc on sc.id = sae.card_id
         where sae.room_id = v_room_id
           and sae.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
      ) t
     order by t.ordinal_ts;
end;
$$;

revoke execute on function public.get_round_modifier_effects(uuid) from public, anon;
grant execute on function public.get_round_modifier_effects(uuid) to authenticated;
