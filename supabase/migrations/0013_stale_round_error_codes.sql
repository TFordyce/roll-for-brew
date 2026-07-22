-- Gives the two "the round moved on under you" rejections their own
-- Postgres error codes, instead of leaving actions.ts's isStaleRoundError
-- to match the tail of the exception message. Every plain `raise exception`
-- in this schema reports SQLSTATE P0001 (plpgsql's default), so message-tail
-- matching was actually the only way to tell "round is not closed for
-- rolling" apart from "round not found" over the wire — a purely cosmetic
-- wording edit to any of these strings would have silently broken the
-- classifier with no compiler error. RFB01/RFB02 are custom SQLSTATEs (5
-- chars, outside the standard classes) scoped to this schema.
create or replace function public.submit_roll(p_round_id uuid)
returns void
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
begin
  v_player_id := public.current_player_id();

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

  v_value := floor(random() * 20 + 1)::integer;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, v_player_id, v_layer, v_value, 'in_app', v_modifier);
end;
$$;

revoke execute on function public.submit_roll(uuid) from public, anon;
grant execute on function public.submit_roll(uuid) to authenticated;

create or replace function public.submit_manual_roll(p_round_id uuid, p_value integer)
returns void
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
begin
  if p_value is null or p_value < 1 or p_value > 20 then
    raise exception 'submit_manual_roll: value must be between 1 and 20';
  end if;

  v_player_id := public.current_player_id();

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_manual_roll: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_manual_roll: round is not closed for rolling'
      using errcode = 'RFB01';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'submit_manual_roll: caller is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = v_player_id;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, v_player_id, v_layer, p_value, 'manual', v_modifier);
end;
$$;

revoke execute on function public.submit_manual_roll(uuid, integer) from public, anon;
grant execute on function public.submit_manual_roll(uuid, integer) to authenticated;

-- get_current_layer_rolls_if_complete's own "caller is not expected to roll"
-- rejection (distinct call site from submit_roll/submit_manual_roll's, same
-- condition) gets the same code, restated here (0012 already added it) only
-- so this migration is the single place documenting the RFB01/RFB02 contract.
comment on function public.submit_roll(uuid) is
  'Raises RFB01 (round not closed) or RFB02 (not an expected roller) for races the caller should treat as stale, not fatal.';
comment on function public.submit_manual_roll(uuid, integer) is
  'Raises RFB01 (round not closed) or RFB02 (not an expected roller) for races the caller should treat as stale, not fatal.';
comment on function public.get_current_layer_rolls_if_complete(uuid) is
  'Raises RFB02 (not an expected roller) for the same stale-round race as submit_roll/submit_manual_roll.';
