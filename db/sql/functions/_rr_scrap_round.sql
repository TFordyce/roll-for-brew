-- _rr_scrap_round(uuid) -> void
--
-- Atomic scrap of a resolved round for replay (issue #315 / #351):
-- snapshots the generation, backs the round out to a freshly-closed
-- generation-1 round, recomputes modifier caches. Internal -- called
-- only by confirm_round_replay. Verbatim from migration 0092.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_scrap_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_status text;
  v_gen integer;
  v_brewer_id text;
  v_cups_made integer;
  v_gain integer;
  v_resolved_at timestamptz;
  v_trace jsonb;
  v_summary jsonb;
  v_snapshot jsonb;
  v_affected text[];
  v_roll_warded text[];
  v_pid text;
  v_heist record;
  v_slot text;
begin
  select room_id, status, replay_generation, brewer_id, cups_made,
         brewer_modifier_gain, resolved_at, resolution_trace, resolution_summary
    into v_room_id, v_status, v_gen, v_brewer_id, v_cups_made,
         v_gain, v_resolved_at, v_trace, v_summary
    from public.rounds
   where id = p_round_id
   for update;

  if v_room_id is null then
    raise exception '_rr_scrap_round: round not found';
  end if;
  if v_status <> 'resolved' then
    raise exception '_rr_scrap_round: round is not resolved (status %)', v_status;
  end if;

  -- Snapshot generation N's Recap payload before the delete pass removes it.
  v_snapshot := jsonb_build_object(
    'generation', v_gen,
    'brewer_id', v_brewer_id,
    'cups_made', v_cups_made,
    'brewer_modifier_gain', v_gain,
    'resolved_at', v_resolved_at,
    'resolution_trace', coalesce(v_trace, '[]'::jsonb),
    -- issue #408: the generation's own layer-0 Resolution Summary (ADR 0007),
    -- so its disclosure rows show that attempt's totals. null when the
    -- generation was resolved before summaries existed.
    'players', v_summary,
    'rolls', coalesce((
      select jsonb_agg(jsonb_build_object(
               'player_id', r.player_id, 'layer', r.layer, 'value', r.value,
               'modifier_snapshot', r.modifier_snapshot,
               'discarded_value', r.discarded_value,
               'entered_by_admin', r.entered_by_admin)
             order by r.layer, r.player_id)
        from public.rolls r
       where r.round_id = p_round_id
    ), '[]'::jsonb),
    'layer_participants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'layer', rlp.layer, 'player_id', rlp.player_id)
             order by rlp.layer, rlp.player_id)
        from public.round_layer_participants rlp
       where rlp.round_id = p_round_id
    ), '[]'::jsonb)
  );

  -- Every player whose modifier cache generation N could have moved. The
  -- brewer's tea-making gain and both sides of any persistent-modifier
  -- transfer / spend are the known movers (spec §9), but rather than track
  -- the exact set, recompute for every round participant plus the brewer
  -- (cheap -- a handful of players -- and immune to a missed effect kind).
  -- Captured BEFORE the delete pass removes the participant rows' basis.
  select coalesce(array_agg(distinct p), array[]::text[])
    into v_affected
    from (
      select v_brewer_id as p where v_brewer_id is not null
      union
      select rp.player_id
        from public.round_participants rp
       where rp.round_id = p_round_id
      union
      select sc.target_player_id
        from public.spell_casts sc
       where sc.round_id = p_round_id
         and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
         and sc.target_player_id is not null
    ) t
   where p is not null;

  -- issue #351: participants holding an active NEGATIVE-polarity roll-domain
  -- ward as of this round keep their generation-0 layer-0 roll instead of
  -- re-rolling in generation 1. Cast-Iron Kettle (polarity {negative}, domain
  -- {modifier, roll}) is the charter case and the only current card that
  -- matches; Jinxed Biscuit is roll-domain but positive so it is excluded
  -- ("Jinxed Biscuit: no interaction" -- decision: Tom, 2026-09-02), and the
  -- modifier-only wards (Bag for Life, Eternal Steep) are excluded by domain.
  -- The carry-over is flat once a ward matches -- polarity only gates which
  -- wards trigger it, not whether a given roll is worth freezing. Computed
  -- BEFORE the spell_casts delete below, since _rr_active_effects_as_of reads
  -- the Cast Log for a ward cast in this very round.
  select coalesce(array_agg(distinct sae.target_player_id), array[]::text[])
    into v_roll_warded
    from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
   where sae.room_id = v_room_id
     and sae.effect_kind = 'ward'
     and sae.effect_params -> 'domain' ? 'roll'
     and sae.effect_params -> 'polarity' ? 'negative'
     and sae.target_player_id in (
       select rp.player_id from public.round_participants rp
        where rp.round_id = p_round_id
     );

  update public.rounds
     set scrapped_generations = scrapped_generations || jsonb_build_array(v_snapshot)
   where id = p_round_id;

  -- Mark Time for Brew's own cast(s) scrapped -- the spec's "written at
  -- confirm time" audit record, and the guard (alongside replay_generation)
  -- that stops a second pending row ever being created for this round.
  perform public._rr_mark_replay_cast_scrapped(p_round_id, true);

  -- Clean casting slate: no pass-1 casts carry into generation 1; cards spent
  -- in pass 1 stay spent (cast_spell_card / cast_reaction_spell_card already
  -- returned / discarded the instance at cast time -- deleting the log row
  -- does not restore it). Deleting a spell_casts row cascades its promoted
  -- spell_active_effects rows away (0084: source_cast_id NOT NULL, ON DELETE
  -- CASCADE), so pass-1-promoted active effects revert and effect-duration
  -- ticks un-happen: _rr_active_effects_as_of counts resolved rounds since the
  -- source cast, and un-resolving this round drops it from that count.
  --
  -- Issue #436 (#383 Q2): a Draw Redirect mark spent inside this generation
  -- (Marked for Brew; its source cast records cast_inputs.consumed_by_round)
  -- is deliberately NOT restored. The crit draw it redirected sits in
  -- pending_spell_draws, which the scrap leaves alone, so the beneficiary
  -- keeps the card -- restoring the mark would let it pay out twice. A mark
  -- cast in an earlier round is not deleted below either; only this round's
  -- casts are, and a mark cast in this round cannot have fired yet.
  --
  -- Issue #438 (Tea Heist, ADR 0005 #383 amendment): a Heist the scrapped
  -- attempt carried out (finalize_layer stamped cast_inputs.heist_moved) is
  -- reversed -- the card goes back to the victim if the thief still holds it
  -- (held or keep-or-swap). It lands in the victim's held slot, their
  -- keep-or-swap slot if they have drawn since (_rr_free_hand_slot), or back
  -- in the deck if both are full. Runs before the delete below removes the cast that records it.
  -- The Tea Heist card itself stays spent.
  for v_heist in
    select c.caster_id, c.target_player_id as victim_id,
           (c.cast_inputs ->> 'stolen_instance_id')::uuid as instance_id
      from public.spell_casts c
     where c.round_id = p_round_id
       and c.effect_kind = 'card_heist'
       and coalesce((c.cast_inputs ->> 'heist_moved')::boolean, false)
  loop
    v_slot := coalesce(public._rr_free_hand_slot(v_heist.victim_id), 'in_deck');

    update public.spell_deck_instances
       set location = v_slot,
           held_by_player = case when v_slot = 'in_deck' then null else v_heist.victim_id end
     where id = v_heist.instance_id
       and held_by_player = v_heist.caster_id
       and location in ('held', 'pending_swap');
  end loop;

  -- Issue #429: every effect the scrapped attempt ended (ended_in_round_id)
  -- is un-ended. Today that is only an Earl of Earl Grey title displaced by
  -- finalize_layer's _rr_apply_earl_title. The title row it
  -- gave the override's caster hangs off that override cast, so the delete
  -- below takes it away.
  update public.spell_active_effects
     set ended_in_round_id = null
   where ended_in_round_id = p_round_id;

  delete from public.spell_casts
   where round_id = p_round_id and effect_kind <> 'round_replay';

  -- The kept round_replay cast still points at generation N's reaction window;
  -- drop that reference before the window rows go (spell_casts.reaction_window_id
  -- is NO ACTION, not cascade).
  update public.spell_casts
     set reaction_window_id = null
   where round_id = p_round_id and effect_kind = 'round_replay';

  -- issue #351: a roll-domain ward holder keeps their generation-0 layer-0
  -- roll (they do not re-roll in generation 1); every other roll -- theirs
  -- at tie-break layers included -- is cleared so the rest of the table
  -- rolls fresh. v_roll_warded is empty in the ordinary case, so this is
  -- an unconditional delete then.
  delete from public.rolls
   where round_id = p_round_id
     and not (layer = 0 and player_id = any (v_roll_warded));
  delete from public.round_layer_participants where round_id = p_round_id;
  delete from public.spell_reaction_windows where round_id = p_round_id;

  -- Discard generation-0 Brew Ratings; Orders (a separate table) carry over
  -- unchanged (spec §11).
  delete from public.brew_ratings where round_id = p_round_id;

  -- Back the round out to a freshly-closed generation-1 round awaiting layer-0
  -- rolls. closed_at = now() restarts the existing 5-minute stall clock for
  -- generation 1. brewer_modifier_gain -> 0 and the cache recompute below back
  -- out the brewer's tea-making gain (base = sum of cups_made over rounds
  -- brewed, per _rr_base_modifier).
  update public.rounds
     set status = 'closed',
         current_layer = 0,
         brewer_id = null,
         cups_made = null,
         brewer_modifier_gain = 0,
         -- issue #432: a scrapped paying round owes its Brew Debt again; a
         -- scrapped Brew IOU round never created one (its cast is gone too)
         brewer_source = null,
         brewer_source_cast_id = null,
         resolved_at = null,
         resolution_trace = null,
         resolution_summary = null,
         replay_generation = replay_generation + 1,
         replay_frozen_rollers = v_roll_warded,
         closed_at = now()
   where id = p_round_id;

  foreach v_pid in array v_affected loop
    perform public._rr_recompute_modifier_cache(v_room_id, v_pid);
  end loop;
end;
$$;

revoke execute on function public._rr_scrap_round(uuid) from public, anon, authenticated;

comment on function public._rr_scrap_round(uuid) is
  'Issue #315: atomic scrap of a resolved round for replay -- snapshots the '
  'generation into rounds.scrapped_generations (issue #408: including its '
  'Resolution Summary as players), deletes its rolls / spell_casts '
  '(cascading promoted active effects) / reaction windows / layer participants / '
  'Brew Ratings (issue #438: first returning any Tea Heist card the thief '
  'still holds to its victim; issue #429: restoring any Earl title it ended), backs the round out to a freshly-closed generation-1 round, '
  'bumps replay_generation, and recomputes room_players.modifier for the brewer '
  'and every round participant. Issue #351: a participant holding an active '
  'roll-domain ward keeps their generation-0 layer-0 roll (no re-roll in '
  'generation 1); the frozen roster is written to rounds.replay_frozen_rollers. '
  'Internal -- called only by confirm_round_replay.';
