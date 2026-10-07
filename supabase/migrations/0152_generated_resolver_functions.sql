-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   get_room_active_effects

-- BEGIN db/sql/functions/get_room_active_effects.sql
-- get_room_active_effects(uuid) -> table
--
-- Roster-badge reader (issue #310): projection-filtered via
-- _rr_active_effects_as_of at the room's latest round. The rounds_remaining
-- output is DERIVED -- the immutable snapshot minus resolved rounds since the
-- source cast, floored at 0 -- and NULL for an unbounded effect.
--
-- Issue #439: a row whose effect_params carries participated_rounds_from_cast
-- = n (a Courage Token) badges n minus the resolved rounds its target has
-- taken part in from the source cast's round -- the same count the
-- projection's liveness test uses, so a live token never badges below 1.
--
-- Issue #472: a duration row badges its Participation Clock rounds left (the
-- target's participated rounds, across rooms), like the projection's test.
--
-- Issue #464: a row whose effect_params carries participated_rounds_after_cast
-- = n (Marked for Brew's mark) badges n minus the target's participated
-- rounds after the cast round -- the projection's window -- so the mark shows
-- a countdown instead of reading as unbounded.
--
-- Body from migration 0084 plus the participated-rounds branch; grants as
-- 0084.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_room_active_effects(p_room_id uuid)
returns table (
  effect_id uuid, target_player_id text, card_name text, tier text, polarity text, rounds_remaining integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_is_admin boolean;
  v_latest_round uuid;
  v_latest_started_at timestamptz;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  select is_admin into v_is_admin from public.players where id = v_player_id;

  if not (
    coalesce(v_is_admin, false)
    and exists (select 1 from public.rooms where id = p_room_id and is_test)
  ) and not exists (
    select 1 from public.room_players
     where room_id = p_room_id and player_id = v_player_id
  ) then
    raise exception 'get_room_active_effects: caller is not a member of this room';
  end if;

  select id, started_at into v_latest_round, v_latest_started_at
    from public.rounds
   where room_id = p_room_id
   order by started_at desc
   limit 1;

  -- source_cast_id is NOT NULL, so these joins are effectively inner; they
  -- give _rr_effect_rounds_elapsed the source cast's round start. The derived
  -- rounds_remaining uses the SAME elapsed count as _rr_active_effects_as_of's
  -- liveness test, so a row it returned can never derive to a negative badge
  -- (greatest(..., 0) is belt-and-braces); NULL stays NULL for unbounded wards.
  return query
    select sae.id, sae.target_player_id, sc.name, sc.tier, sc.polarity,
           case
             when sae.effect_params ->> 'participated_rounds_from_cast' is not null then
               greatest(
                 (sae.effect_params ->> 'participated_rounds_from_cast')::integer
                 - public._rr_participated_rounds_elapsed(
                     p_room_id, sae.target_player_id, sr.started_at, v_latest_started_at),
                 0
               )::integer
             when sae.effect_params ->> 'participated_rounds_after_cast' is not null then
               -- issue #464 (Marked for Brew): counted from the first round
               -- after the cast round, in any room of the same kind -- the
               -- projection's window start
               greatest(
                 (sae.effect_params ->> 'participated_rounds_after_cast')::integer
                 - public._rr_participated_rounds_elapsed(
                     p_room_id, sae.target_player_id,
                     (select min(nr.started_at) from public.rounds nr
                        join public.rooms nrm on nrm.id = nr.room_id
                       where nrm.is_test = (select is_test from public.rooms where id = p_room_id)
                         and nr.started_at > sr.started_at),
                     v_latest_started_at),
                 0
               )::integer
             when sae.rounds_remaining is null then null
             else greatest(
               sae.rounds_remaining
               - public._rr_participated_rounds_elapsed(
                   p_room_id, sae.target_player_id, sr.started_at, v_latest_started_at),
               0
             )::integer
           end as rounds_remaining
      from public._rr_active_effects_as_of(p_room_id, v_latest_round) sae
      join public.spell_cards sc on sc.id = sae.card_id
      join public.spell_casts scx on scx.id = sae.source_cast_id
      join public.rounds sr on sr.id = scx.round_id;
end;
$$;

revoke execute on function public.get_room_active_effects(uuid) from public, anon;
grant execute on function public.get_room_active_effects(uuid) to authenticated;

comment on function public.get_room_active_effects(uuid) is
  'Issue #310: roster-badge reader -- projection-filtered via '
  '_rr_active_effects_as_of at the room''s latest round; the rounds_remaining '
  'output is DERIVED (immutable snapshot minus resolved rounds since the '
  'source cast, floored at 0), NULL for an unbounded ward. (#439) A '
  'participated_rounds_from_cast row badges its participated rounds left; '
  '(#464) so does a participated_rounds_after_cast row (Marked for Brew), '
  'counted after the cast round.';
-- END db/sql/functions/get_room_active_effects.sql

