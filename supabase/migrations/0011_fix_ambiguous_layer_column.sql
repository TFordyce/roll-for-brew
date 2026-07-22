-- Fixes "column reference \"layer\" is ambiguous" (Postgres 42702), thrown
-- whenever get_current_layer_rolls_if_complete ran. Its `returns table
-- (layer integer, ...)` clause implicitly declares a plpgsql OUT variable
-- named `layer`, which collided with the unqualified `layer` column in the
-- round_layer_participants and rolls lookups below. Qualifying both with
-- their table aliases resolves it; behaviour is otherwise unchanged from
-- #20's version in 0007_reroll_layers.sql.
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
    raise exception 'get_current_layer_rolls_if_complete: caller is not expected to roll in the current layer';
  end if;

  if v_layer = 0 then
    select count(*) into v_expected_count
      from public.round_participants
     where round_id = p_round_id;
  else
    select count(*) into v_expected_count
      from public.round_layer_participants rlp
     where rlp.round_id = p_round_id and rlp.layer = v_layer;
  end if;

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
