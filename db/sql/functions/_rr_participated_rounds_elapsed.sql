-- _rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) -> integer
--
-- The Participation Clock (issue #472, ADR 0005 "Carried Effect amendment"):
-- resolved rounds in [p_source_started_at, p_as_of_started_at) that
-- p_player_id took part in -- has a round_participants row for -- ACROSS
-- rooms, ordered by rounds.started_at. Same bounds as before: source
-- inclusive, as-of strict, a NULL as-of drops the upper bound.
--
-- p_room_id no longer filters the count; it only says which kind of room the
-- clock runs in: rooms with the same is_test as p_room_id are counted, so a
-- Test Room never ticks a real room's clock (or vice versa). A Carried
-- Effect follows its target from room to room on this one count.
--
-- "Took part" is participation, not rolling: a round the player joined but
-- never rolled in (a Tea Cosy round, a Roll Exemption, a Brew Debt round)
-- still counts; a round they sat out does not. It is the duration clock for
-- EVERY duration_rounds card (#472) and for Marked for Brew's 5-round window
-- and the Courage Token's 3 rounds (#435), which keep their own start
-- offsets.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_participated_rounds_elapsed(
  p_room_id uuid, p_player_id text,
  p_source_started_at timestamptz, p_as_of_started_at timestamptz
)
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
    from public.rounds r
    join public.round_participants rp
      on rp.round_id = r.id and rp.player_id = p_player_id
    join public.rooms rm on rm.id = r.room_id
   where rm.is_test = (select is_test from public.rooms where id = p_room_id)
     and r.status = 'resolved'
     and r.started_at >= p_source_started_at
     and (p_as_of_started_at is null or r.started_at < p_as_of_started_at);
$$;

revoke execute on function public._rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) from public, anon;
grant execute on function public._rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
