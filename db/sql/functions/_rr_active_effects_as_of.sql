-- _rr_active_effects_as_of(uuid, uuid) -> setof spell_active_effects
--
-- The projection row source (issue #310, migration 0084): the
-- spell_active_effects rows LIVE as of p_as_of_round_id. Drop-in for
-- `from public.spell_active_effects sae` in any reader that has a room id and
-- a round id in scope.
--
-- A row is live as of the given round iff ALL of:
--   * its source cast is not negated;
--   * its duration is not exhausted: rounds_remaining IS NULL (unbounded), OR
--     the number of resolved rounds in [source-cast's round .started_at,
--     as-of round .started_at) is < rounds_remaining
--     (_rr_effect_rounds_elapsed);
--   * it has not been dispelled at or before the as-of round: no non-negated
--     'dispel' cast whose effect_params.ended_effect_id names this row sits
--     in a round started on/before the as-of round;
--   * it has not been spent (issue #435, spec #401 F6): its source cast
--     records neither cast_inputs.consumed_by_round nor
--     cast_inputs.consumed_by_draw. A one-shot effect (a Draw Redirect mark)
--     writes one of these when it fires. Unlike a dispel this is not bounded
--     by the as-of round -- a fired mark is spent for good, even to an as-of
--     read of an earlier round, and a Round replay scrap does not restore it
--     (#383 Q2), because the card it moved survives the scrap.
--
-- An is_undispellable row (issue #428: The Last Cuppa) skips the dispel
-- check -- no dispel cast can end it, even one that names it.
--
-- Body from migration 0084 plus the spent condition; grants merge 0084
-- (authenticated) and 0108 (service_role, the integration suite's seam).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_active_effects_as_of(
  p_room_id uuid, p_as_of_round_id uuid
)
returns setof public.spell_active_effects
language sql
stable
set search_path = public
as $$
  -- Not SECURITY DEFINER: like _rr_active_ward_gate (0082), this is only ever
  -- reached from within a SECURITY DEFINER reader, so it runs with that
  -- reader's privileges. A direct call by `authenticated` hits RLS on
  -- spell_active_effects (no select policy) and returns nothing -- the room
  -- membership gate stays with the public-facing RPCs.
  with as_of as (
    select started_at from public.rounds where id = p_as_of_round_id
  )
  select sae.*
    from public.spell_active_effects sae
    join public.spell_casts src on src.id = sae.source_cast_id
    join public.rounds src_round on src_round.id = src.round_id
   where sae.room_id = p_room_id
     and coalesce(src.negated, false) = false
     and src.cast_inputs ->> 'consumed_by_round' is null
     and src.cast_inputs ->> 'consumed_by_draw' is null
     and (
       sae.rounds_remaining is null
       or public._rr_effect_rounds_elapsed(
            p_room_id, src_round.started_at, (select started_at from as_of)
          ) < sae.rounds_remaining
     )
     and (
       sae.is_undispellable
       or not exists (
         select 1
           from public.spell_casts dc
           join public.rounds dr on dr.id = dc.round_id
          where dc.effect_kind = 'dispel'
            and dc.effect_params ->> 'ended_effect_id' = sae.id::text
            and coalesce(dc.negated, false) = false
            and dr.started_at <= (select started_at from as_of)
       )
     );
$$;

revoke execute on function public._rr_active_effects_as_of(uuid, uuid) from public, anon;
grant execute on function public._rr_active_effects_as_of(uuid, uuid) to authenticated, service_role;

comment on function public._rr_active_effects_as_of(uuid, uuid) is
  'Issue #310: the spell_active_effects rows live as of a given round -- '
  'source cast not negated, duration not exhausted (resolved-round count '
  'since the source round), not dispelled at/before the round (an '
  'is_undispellable row, #428, never is), and (#435) '
  'not spent (source cast_inputs.consumed_by_round / consumed_by_draw). '
  'The shared row source for every reader that treats spell_active_effects '
  'as current game state (the ward gate/map, dispel/room badge readers, '
  'resolve_round''s phases).';
