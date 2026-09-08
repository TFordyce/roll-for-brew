-- start_round(p_room_id uuid default null) -> uuid
--
-- Open a new round for the caller's room, room-locked while a replay
-- decision is pending (stalled ones auto-declined first). Verbatim from
-- migration 0090.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.start_round(p_room_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_date date;
  v_room_id uuid;
  v_round_id uuid;
begin
  if p_room_id is not null then
    v_room_id := p_room_id;
  else
    v_date := (now() at time zone 'Europe/London')::date;
    select id into v_room_id from public.rooms where date = v_date;
  end if;

  if v_room_id is null then
    raise exception 'start_round: no room for today';
  end if;

  -- A round replay decision pending for this room locks new rounds (spec §11).
  -- Clear any that have stalled past the 5-minute window first.
  perform public.auto_decline_stalled_round_replays();

  if exists (
    select 1 from public.pending_round_replay
     where room_id = v_room_id
  ) then
    raise exception 'start_round: a round replay decision is still pending for this room'
      using errcode = 'RFB47';
  end if;

  v_player_id := public.current_player_id(null, v_room_id);

  insert into public.rounds (room_id, started_by, status)
  values (v_room_id, v_player_id, 'open')
  returning id into v_round_id;

  insert into public.round_participants (round_id, player_id)
  values (v_round_id, v_player_id);

  return v_round_id;
end;
$$;

revoke execute on function public.start_round(uuid) from public, anon;
grant execute on function public.start_round(uuid) to authenticated;

comment on function public.start_round(uuid) is
  'Issue #315: same as 0026 plus a room lock -- raises RFB47 while a '
  'pending_round_replay decision is outstanding for the room (stalled ones are '
  'auto-declined first).';
