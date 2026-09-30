-- _rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) -> integer
--
-- Issue #435 (spec #401 F3, #383 Q3 / #384): resolved rounds in
-- [p_source_started_at, p_as_of_started_at) that p_player_id took part in --
-- has a round_participants row for -- in p_room_id. The per-player sibling of
-- _rr_effect_rounds_elapsed (0084), which counts every resolved room round.
-- Same bounds: source inclusive, as-of strict, a NULL as-of drops the upper
-- bound.
--
-- "Took part" is participation, not rolling: a round the player joined but
-- never rolled in (a Tea Cosy round, a Roll Exemption, a Brew Debt round)
-- still counts; a round they sat out does not. Shared duration clock for
-- Marked for Brew's 5-round window and the Courage Token's 3 rounds.
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
   where r.room_id = p_room_id
     and r.status = 'resolved'
     and r.started_at >= p_source_started_at
     and (p_as_of_started_at is null or r.started_at < p_as_of_started_at);
$$;

revoke execute on function public._rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) from public, anon;
grant execute on function public._rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
