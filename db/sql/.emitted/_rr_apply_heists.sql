-- _rr_apply_heists(p_round_id uuid) -> void
--
-- Tea Heist's move (issue #438, ADR 0005 #383 amendment). Called only by
-- finalize_layer's commit step, in the same transaction as the resolution
-- write -- never by the resolver, whose body also runs as the Provisional
-- Recap's rolled-back dry run (ADR 0007).
--
-- For every `moved` row of _rr_heist_outcomes, moves the pinned card from the
-- victim to the thief: into the thief's held slot, or -- if a crit draw has
-- refilled it since casting -- their keep-or-swap slot, so the one-card hand
-- cap holds. The Heist is not a draw, so no spell_draws row is written. The
-- cast is stamped cast_inputs.heist_moved, which _rr_scrap_round reads to
-- hand the card back on a Round Replay.
--
-- Safe to repeat: the update only fires while the victim still holds the
-- card, so a re-run finds it with the thief and does nothing.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_apply_heists(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_heist record;
  v_slot text;
begin
  for v_heist in
    select h.cast_id, h.caster_id, h.victim_id, h.instance_id
      from public._rr_heist_outcomes(p_round_id) h
     where h.outcome = 'moved'
  loop
    -- never null for a `moved` row: _rr_heist_outcomes fizzles a full hand
    v_slot := public._rr_free_hand_slot(v_heist.caster_id);

    update public.spell_deck_instances
       set location = v_slot, held_by_player = v_heist.caster_id
     where id = v_heist.instance_id
       and location = 'held'
       and held_by_player = v_heist.victim_id;

    if found then
      update public.spell_casts
         set cast_inputs = cast_inputs || jsonb_build_object('heist_moved', true)
       where id = v_heist.cast_id;
    end if;
  end loop;
end;
$$;

revoke execute on function public._rr_apply_heists(uuid) from public, anon, authenticated;

comment on function public._rr_apply_heists(uuid) is
  'Issue #438 (Tea Heist, ADR 0005 #383 amendment): moves each un-negated Heist''s pinned card from victim to thief (held, or pending_swap if the thief''s hand refilled), stamping cast_inputs.heist_moved. Called only by finalize_layer''s commit step. Idempotent: moves only while the victim still holds the card. Internal.';
