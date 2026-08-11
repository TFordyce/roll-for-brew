-- Late Declare (issue #246): lets a player join a round after close_round
-- has already run, as long as no roll has landed for it yet — the window
-- CONTEXT.md's "Late Declare" glossary entry (#256) describes. declare_in
-- itself stays untouched (still hard-blocked once status <> 'open'); this is
-- a separate RPC, not a relaxed declare_in, following the codebase's
-- one-RPC-one-purpose convention (declare_in/withdraw_declaration,
-- cast_spell_card/set_spell_cast_target).
--
-- Same identity derivation and room-membership check as declare_in
-- (0004_round_lifecycle.sql), but the status guard is "closed AND no rolls
-- yet" instead of "open". Raises RFB31 — the next in the RFB01-30 sequence
-- (RFB05 is declare_in's own version of this same "moved on under you" race,
-- one phase earlier) — for the race where a roll lands between the page
-- rendering the "Add me in!" button and the form actually submitting.
create or replace function public.declare_in_late(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id();

  select status, room_id into v_status, v_room_id
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'declare_in_late: round not found';
  end if;

  if v_status <> 'closed' or exists (
    select 1 from public.rolls where round_id = p_round_id
  ) then
    raise exception 'declare_in_late: round is no longer open for a late declare'
      using errcode = 'RFB31';
  end if;

  if not exists (
    select 1 from public.room_players
     where room_id = v_room_id and player_id = v_player_id
  ) then
    raise exception 'declare_in_late: caller is not present in this round''s room';
  end if;

  insert into public.round_participants (round_id, player_id)
  values (p_round_id, v_player_id)
  on conflict (round_id, player_id) do nothing;
end;
$$;

revoke execute on function public.declare_in_late(uuid) from public, anon;
grant execute on function public.declare_in_late(uuid) to authenticated;

comment on function public.declare_in_late(uuid) is
  'Raises RFB31 (round no longer open for a late declare) for the same stale-round race pattern as declare_in''s RFB05, one phase later — the round can close-then-roll between the "Add me in!" button rendering and the form submitting.';

-- Whether a round has any rolls yet at all (any layer) — used to decide
-- whether the "Add me in!" (Late Declare) button is still safe to show for
-- a closed round. Plain RLS on rolls only lets a caller see their own rows
-- (or anyone's, once resolved, 0005_rolls_and_resolution.sql) — a player who
-- hasn't declared in yet has no rolls of their own to see, so this needs its
-- own security-definer existence check rather than a client-side count.
create or replace function public.round_has_any_rolls(p_round_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_player_id text;
begin
  v_player_id := public.current_player_id();

  select room_id into v_room_id from public.rounds where id = p_round_id;
  if v_room_id is null then
    raise exception 'round_has_any_rolls: round not found';
  end if;

  if not exists (
    select 1 from public.room_players
     where room_id = v_room_id and player_id = v_player_id
  ) then
    raise exception 'round_has_any_rolls: caller is not present in this round''s room';
  end if;

  return exists (select 1 from public.rolls where round_id = p_round_id);
end;
$$;

revoke execute on function public.round_has_any_rolls(uuid) from public, anon;
grant execute on function public.round_has_any_rolls(uuid) to authenticated;
