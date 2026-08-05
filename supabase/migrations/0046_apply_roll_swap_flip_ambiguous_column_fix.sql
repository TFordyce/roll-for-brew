-- Fix #145: apply_roll_swap and apply_roll_flip both declare
-- `returns table (player_id text, value integer)`, and plpgsql implicitly
-- declares each output column as a variable of the same name in scope for
-- the whole function body. Their update statements referenced the bare
-- column names `player_id` / `value` in a WHERE/SET expression, which
-- Postgres can no longer resolve unambiguously against the rolls table's
-- own columns of the same name -- raising a 42702 ambiguous-column error
-- at call time instead of running the swap/flip.
--
-- Fix: alias the rolls table and qualify every reference that collides with
-- an output column name, leaving the return shape and game logic unchanged.
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

  update public.rolls as r set value = v_low_value where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_high_player;
  update public.rolls as r set value = v_high_value where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_low_player;

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
  update public.rolls as r
     set value = 21 - r.value
   where r.round_id = p_round_id and r.layer = p_layer;

  return query
    select r.player_id, r.value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = p_layer;
end;
$$;

revoke execute on function public.apply_roll_flip(uuid, integer) from public, anon;
grant execute on function public.apply_roll_flip(uuid, integer) to authenticated;
