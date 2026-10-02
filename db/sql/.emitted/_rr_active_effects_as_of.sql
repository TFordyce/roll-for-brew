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
--   * its participated-rounds window is open (issue #436, Marked for Brew):
--     a row whose effect_params carries participated_rounds_after_cast = n
--     is live while its target has taken part in fewer than n resolved
--     rounds strictly after the source cast's round and before the as-of
--     round (_rr_participated_rounds_elapsed, counted from the room's next
--     round after the cast round). Live in the cast round itself, so the
--     roster badge shows the mark at once; _apply_crit_redirect separately
--     never fires a mark in its cast round. Rows without the key ignore it.
--
--   * its participated-rounds window counted FROM the cast round is open
--     (issue #439, Liquid Courage's Courage Token): a row whose effect_params
--     carries participated_rounds_from_cast = n is live while its target has
--     taken part in fewer than n resolved rounds from the source cast's round
--     (inclusive) up to the as-of round -- so the gift round counts once it
--     has resolved, and only if the target took part in it.
--
--   * it is not a spent Courage Token (issue #439): a `courage_token` row
--     with a non-negated spend row (cast_inputs.courage_token_cast_id naming
--     its source cast) in a round started on/before the as-of round is
--     spent. Bounded by the as-of round like a dispel, so an earlier round's
--     read still sees the token, and a Round replay -- which deletes the
--     scrapped attempt's spend rows -- leaves it unspent again.
--
--   * it has not been ended in or before the as-of round (issue #429):
--     ended_in_round_id is null, or names a round started after the as-of
--     round.
--
-- An is_undispellable row (issue #428: The Last Cuppa) skips the dispel
-- check -- no dispel cast can end it, even one that names it.
--
-- One Earl (issue #429, Earl of Earl Grey): of the Earl title rows
-- (`brewer_immunity`, mode `earl`) live by the rules above, only the newest
-- (created_at, then id) is returned. A new Earl displaces the old one from
-- the round the title is taken in -- before finalize_layer has ended the old
-- row -- and a countered or dispelled newer title leaves the older one
-- standing until something actually ends it.
--
-- Body from migration 0084 plus the spent and participated-window
-- conditions; grants merge 0084 (authenticated) and 0108 (service_role, the
-- integration suite's seam).
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
  ),
  live as (
    select sae.*
      from public.spell_active_effects sae
      join public.spell_casts src on src.id = sae.source_cast_id
      join public.rounds src_round on src_round.id = src.round_id
      left join public.rounds ended_round on ended_round.id = sae.ended_in_round_id
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
         sae.effect_params ->> 'participated_rounds_after_cast' is null
         or public._rr_participated_rounds_elapsed(
              p_room_id, sae.target_player_id,
              -- the room's first round after the cast round; NULL (none yet)
              -- counts nothing
              (select min(nr.started_at) from public.rounds nr
                where nr.room_id = p_room_id and nr.started_at > src_round.started_at),
              (select started_at from as_of)
            ) < (sae.effect_params ->> 'participated_rounds_after_cast')::integer
       )
       and (
         sae.effect_params ->> 'participated_rounds_from_cast' is null
         or public._rr_participated_rounds_elapsed(
              p_room_id, sae.target_player_id,
              src_round.started_at,
              (select started_at from as_of)
            ) < (sae.effect_params ->> 'participated_rounds_from_cast')::integer
       )
       and not (
         sae.effect_kind = 'courage_token'
         and exists (
           select 1
             from public.spell_casts sp
             join public.rounds spr on spr.id = sp.round_id
            where sp.cast_inputs ->> 'courage_token_cast_id' = sae.source_cast_id::text
              and coalesce(sp.negated, false) = false
              and spr.started_at <= (select started_at from as_of)
         )
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
       )
       and (
         ended_round.id is null
         or ended_round.started_at > (select started_at from as_of)
       )
  )
  select l.*
    from live l
   where not (
     l.effect_kind = 'brewer_immunity'
     and l.effect_params ->> 'mode' = 'earl'
     and exists (
       select 1
         from live newer
         join public.spell_casts newer_src on newer_src.id = newer.source_cast_id
         join public.rounds newer_round on newer_round.id = newer_src.round_id
        where newer.effect_kind = 'brewer_immunity'
          and newer.effect_params ->> 'mode' = 'earl'
          and (newer.created_at, newer.id) > (l.created_at, l.id)
          -- only a title cast by the as-of round displaces: a historical read
          -- still sees that round's Earl
          and newer_round.started_at <= (select started_at from as_of)
     )
   );
$$;

revoke execute on function public._rr_active_effects_as_of(uuid, uuid) from public, anon;
grant execute on function public._rr_active_effects_as_of(uuid, uuid) to authenticated, service_role;

comment on function public._rr_active_effects_as_of(uuid, uuid) is
  'Issue #310: the spell_active_effects rows live as of a given round -- '
  'source cast not negated, duration not exhausted (resolved-round count '
  'since the source round), not dispelled at/before the round (an '
  'is_undispellable row, #428, never is), (#435) '
  'not spent (source cast_inputs.consumed_by_round / consumed_by_draw), '
  '(#436) inside its participated-rounds window (effect_params.'
  'participated_rounds_after_cast, counted after the cast round), (#439) '
  'inside its participated-rounds window counted from the cast round '
  '(participated_rounds_from_cast) and not a spent Courage Token, and '
  '(#429) not ended in or before the round (ended_in_round_id). Of the Earl '
  'title rows only the newest live one is returned -- one Earl per room. '
  'The shared row source for every reader that treats spell_active_effects '
  'as current game state (the ward gate/map, dispel/room badge readers, '
  'resolve_round''s phases).';
