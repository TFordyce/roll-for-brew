-- _rr_heist_outcomes(p_round_id uuid) -> table
--
-- Tea Heist (issue #438, spec #401, ADR 0005 #383 amendment): what each of
-- the round's Heists does, decided from the Cast Log and the pinned card's
-- current place. One row per Tea Heist cast, in cast order. Read by both
-- sides of the split the ADR amendment records:
--   * _rr_resolve_eval traces the outcome (a `card_heist` step) -- it runs
--     for real inside finalize_layer and as a rolled-back dry run for every
--     viewer's Provisional Recap, so it must only decide, never move;
--   * _rr_apply_heists, called by finalize_layer's commit step, moves the
--     card for each `moved` row.
--
-- Outcomes, checked in this order:
--   moved      -- already moved by an earlier commit (cast_inputs.heist_moved),
--                 so a re-evaluation keeps saying what happened;
--   fizzled    -- `already_stolen`: an earlier Heist this round takes the
--                 same card;
--   fizzled    -- `victim_played_first`: the pinned card is no longer the
--                 victim's held card (they cast it -- counters included -- or
--                 discarded it). Checked before negation: a victim who
--                 counters the Heist WITH the pinned card fizzles it, per
--                 spec #401 story 62;
--   countered  -- the Heist cast was negated (Phase 1 of the resolver has
--                 already settled `negated` by the time this is read);
--   fizzled    -- `thief_hand_full`: the thief has both a held card and a
--                 keep-or-swap card (a crit draw since casting), so the
--                 one-card hand cap leaves nowhere to land it;
--   moved      -- otherwise.
--
-- Saucerer's Apprentice copies (cast_inputs.is_copy) carry no pinned card
-- and are ignored.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_heist_outcomes(p_round_id uuid)
returns table (
  cast_id uuid,
  caster_id text,
  victim_id text,
  instance_id uuid,
  card_name text,
  outcome text,
  reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cast record;
  v_claimed uuid[] := array[]::uuid[];
  v_location text;
  v_holder text;
begin
  for v_cast in
    select c.id, c.caster_id, c.target_player_id, c.negated, c.cast_inputs, sc.name as card_name
      from public.spell_casts c
      join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where c.round_id = p_round_id
       and c.effect_kind = 'card_heist'
       and c.cast_inputs ? 'stolen_instance_id'
       and not (c.cast_inputs ? 'is_copy')
     order by c.seq
  loop
    cast_id := v_cast.id;
    caster_id := v_cast.caster_id;
    victim_id := v_cast.target_player_id;
    instance_id := (v_cast.cast_inputs ->> 'stolen_instance_id')::uuid;
    card_name := v_cast.card_name;
    reason := null;

    select sdi.location, sdi.held_by_player into v_location, v_holder
      from public.spell_deck_instances sdi
     where sdi.id = instance_id;

    if coalesce((v_cast.cast_inputs ->> 'heist_moved')::boolean, false) then
      outcome := 'moved';
    elsif instance_id = any (v_claimed) then
      outcome := 'fizzled';
      reason := 'already_stolen';
    elsif v_location is distinct from 'held' or v_holder is distinct from victim_id then
      outcome := 'fizzled';
      reason := 'victim_played_first';
    elsif v_cast.negated then
      outcome := 'countered';
    elsif exists (
            select 1 from public.spell_deck_instances sdi
             where sdi.held_by_player = v_cast.caster_id and sdi.location = 'held'
          )
      and exists (
            select 1 from public.spell_deck_instances sdi
             where sdi.held_by_player = v_cast.caster_id and sdi.location = 'pending_swap'
          ) then
      outcome := 'fizzled';
      reason := 'thief_hand_full';
    else
      outcome := 'moved';
    end if;

    if outcome = 'moved' then
      v_claimed := v_claimed || instance_id;
    end if;

    return next;
  end loop;
end;
$$;

revoke execute on function public._rr_heist_outcomes(uuid) from public, anon, authenticated;

comment on function public._rr_heist_outcomes(uuid) is
  'Issue #438 (Tea Heist, ADR 0005 #383 amendment): one row per Tea Heist cast in the round, in cast order -- { cast_id, caster_id, victim_id, instance_id, card_name, outcome: moved | fizzled | countered, reason: already_stolen | victim_played_first | thief_hand_full | null }. Decides only; _rr_resolve_eval traces it and _rr_apply_heists (finalize_layer''s commit) acts on it. Internal.';
