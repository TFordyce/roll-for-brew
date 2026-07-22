-- Consolidates the "how many rollers does this layer expect" count into one
-- routine, shared by get_current_layer_rolls_if_complete and
-- get_completed_layer_rolls_for_stall_resolution. Before this migration the
-- count was copy-pasted into both functions, and the two copies had already
-- drifted: 0011's rewrite of get_current_layer_rolls_if_complete (fixing an
-- unrelated ambiguous-column error) dropped the `excluded_at is null` filter
-- that 0009 added, silently reintroducing the "excluded player blocks
-- resolution forever" bug for the identity-gated RPC while the
-- stall-resolution RPC kept the filter intact. This migration restores the
-- filter and gives both callers one place to drift from now on.
--
-- get_completed_layer_rolls_for_stall_resolution's own roll-count query has
-- the same unqualified `layer` column that caused 0011's "ambiguous column
-- reference" error in its sibling (both functions declare an implicit OUT
-- parameter named `layer` via their `returns table (layer integer, ...)`
-- clause) — it just hadn't been hit yet. Qualified with a table alias here
-- too, for the same reason 0011 qualified the other function's.
--
-- Not exposed to authenticated/anon: only called from within the two
-- SECURITY DEFINER RPCs below, which run as this function's owner.
create or replace function public.count_expected_layer_rollers(p_round_id uuid, p_layer integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_layer = 0 then
    select count(*) into v_count
      from public.round_participants
     where round_id = p_round_id and excluded_at is null;
  else
    select count(*) into v_count
      from public.round_layer_participants
     where round_id = p_round_id and layer = p_layer and excluded_at is null;
  end if;

  return v_count;
end;
$$;

revoke execute on function public.count_expected_layer_rollers(uuid, integer) from public, anon, authenticated;

create or replace function public.get_current_layer_rolls_if_complete(p_round_id uuid)
returns table (layer integer, player_id text, value integer, modifier_snapshot integer)
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
  v_player_id := public.current_player_id();

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
    select r.layer, r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_current_layer_rolls_if_complete(uuid) from public, anon;
grant execute on function public.get_current_layer_rolls_if_complete(uuid) to authenticated;

create or replace function public.get_completed_layer_rolls_for_stall_resolution(p_round_id uuid)
returns table (layer integer, player_id text, value integer, modifier_snapshot integer)
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
    select r.layer, r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) from public, anon;
grant execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) to authenticated;
