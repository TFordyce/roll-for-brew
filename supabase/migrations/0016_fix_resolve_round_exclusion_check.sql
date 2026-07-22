-- resolve_round's "has everyone rolled" check (v_expected_layer_count)
-- never accounted for stall-excluded participants
-- (0009_stall_timeout.sql's round_participants.excluded_at /
-- round_layer_participants.excluded_at), so a round with a stalled-out
-- participant excluded could never resolve — it kept expecting a roll from
-- someone stall-timeout enforcement had already excluded. Redefined here on
-- top of 0014's count_expected_layer_rollers, the same shared source of
-- truth get_current_layer_rolls_if_complete and
-- get_completed_layer_rolls_for_stall_resolution already use, instead of
-- re-deriving the count by hand a third time.
--
-- v_participant_count, used separately for the cups_made check, deliberately
-- stays unfiltered: cups_made must still equal the round's *original*
-- participant count regardless of who got excluded along the way (see
-- 0007's comment on this function).
create or replace function public.resolve_round(p_round_id uuid, p_brewer_id text, p_cups_made integer)
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

  update public.room_players
     set modifier = modifier + p_cups_made
   where room_id = v_room_id and player_id = p_brewer_id;
end;
$$;

revoke execute on function public.resolve_round(uuid, text, integer) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer) to authenticated;
