-- Spell Cards 1/5 (issue #66): rolling a natural 1 or natural 20 on the main
-- round roll draws a spell card for the roller (US1/US2). Wired directly
-- into submit_roll/submit_manual_roll (redefined here, unchanged otherwise
-- from 0013's RFB01/RFB02 version) rather than as a separate client-driven
-- step, so the draw is atomic with the roll insert — no race where the
-- client reads the just-submitted value back before triggering the draw,
-- and consistent with this schema's existing "every invariant-sensitive
-- write goes through security-definer SQL" convention. draw_spell_card
-- (0018) derives its own caller via current_player_id(), so calling it from
-- within another security-definer function's body needs no extra
-- parameter-passing for identity.
--
-- Scoped deliberately to just these two functions: a card's own resolution
-- roll (e.g. a future counterspell DC check) is never routed through
-- submit_roll/submit_manual_roll, so it can never itself trigger a draw —
-- satisfying US32/AC "a card's own resolution roll never triggers a draw"
-- without needing any special-case guard here.
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

  if v_value = 1 or v_value = 20 then
    perform public.draw_spell_card(p_round_id);
  end if;
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

  if p_value = 1 or p_value = 20 then
    perform public.draw_spell_card(p_round_id);
  end if;
end;
$$;

revoke execute on function public.submit_manual_roll(uuid, integer) from public, anon;
grant execute on function public.submit_manual_roll(uuid, integer) to authenticated;

comment on function public.submit_roll(uuid) is
  'Raises RFB01 (round not closed) or RFB02 (not an expected roller) for races the caller should treat as stale, not fatal. Draws a spell card (draw_spell_card) when the rolled value is a natural 1 or 20.';
comment on function public.submit_manual_roll(uuid, integer) is
  'Raises RFB01 (round not closed) or RFB02 (not an expected roller) for races the caller should treat as stale, not fatal. Draws a spell card (draw_spell_card) when the submitted value is a natural 1 or 20.';
