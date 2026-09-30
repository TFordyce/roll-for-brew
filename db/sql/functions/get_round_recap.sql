-- get_round_recap(p_round_id uuid) -> jsonb
--
-- Round Recap read surface (issue #314, "the Ledger") + round-replay follow-up
-- (issue #352) + roll rows from the resolver (spec #402, ADR 0007): one
-- room-member-gated RPC that hands the client everything RoundReveal needs in a
-- single round trip -- the Resolution Trace and Resolution Summary (stored, or
-- the Provisional Recap's dry run while the round is live), the round's full
-- cast list with each cast's phase and coarse live state, its revealed layer
-- rolls and tie-break participants, and every scrapped replay generation's
-- retained Recap payload.
--
-- Leaves no writes: the provisional path calls _rr_resolve, whose writes all
-- roll back. spell_casts still has no direct SELECT policy (0019), so this
-- SECURITY DEFINER function is the read path.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_round_recap(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_trace jsonb;
  v_summary jsonb;
  v_provisional boolean := false;
  v_dry jsonb;
  v_casts jsonb;
  v_scrapped jsonb;
  v_layers jsonb;
  v_layer_participants jsonb;
begin
  v_player_id := public.current_player_id(p_round_id);

  select r.status, r.room_id, r.current_layer,
         coalesce(r.resolution_trace, '[]'::jsonb),
         r.resolution_summary,
         coalesce(r.scrapped_generations, '[]'::jsonb)
    into v_status, v_room_id, v_layer, v_trace, v_summary, v_scrapped
    from public.rounds r
   where r.id = p_round_id
     -- Issue #414: the dry run below writes (then rolls back) the same Cast
     -- Log rows Layer finalization writes. finalize_layer / resolve_round
     -- hold the round row lock FOR UPDATE before their writes; taking it FOR
     -- SHARE here, before ours, orders the two instead of letting them
     -- deadlock on those rows, and means the status read above is still
     -- true when the dry run starts. Concurrent Recap reads don't block each
     -- other.
     for share;

  if v_status is null then
    raise exception 'get_round_recap: round not found';
  end if;

  -- Issue #409: any member of the round's room may read it -- a spectator
  -- follows the round too (spec #402 story 25). Nothing here is hidden
  -- information: casts are already visible to the room.
  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) and not exists (
    select 1 from public.room_players
     where room_id = v_room_id and player_id = v_player_id
  ) then
    raise exception 'get_round_recap: caller is not in this round''s room';
  end if;

  -- Issue #409: the Provisional Recap (ADR 0007). While the round is live at
  -- layer 0 with nothing stored yet, and layer 0 is complete -- every roll
  -- in, no unrolled Pending Spell Die, no deferred forced-reroll target hold
  -- (the same holds as _layer_is_complete) -- dry-run the
  -- resolver with _rr_resolve, which leaves no writes, and return its Trace
  -- and summary marked provisional. A resolved round, or a layer-0 outcome
  -- already stored (a tie that moved on to tie-break layers), returns the
  -- stored Trace and summary as final.
  if v_status = 'closed' and v_layer = 0 and v_summary is null
     and (select count(*) from public.rolls where round_id = p_round_id and layer = 0)
         >= public.count_expected_layer_rollers(p_round_id, 0)
     and not exists (
       select 1 from public.spell_casts
        where round_id = p_round_id and effect_kind = 'dice_modifier'
          and not coalesce(cast_inputs ? 'dice_roll', false)
     )
     and not exists (
       select 1 from public.spell_casts
        where round_id = p_round_id
          and effect_kind = 'forced_reroll'
          and target_pending = true
          and negated = false
          and reaction_window_id is null
     ) then
    v_dry := public._rr_resolve(p_round_id);
    v_trace := coalesce(v_dry -> 'trace', '[]'::jsonb);
    v_summary := v_dry -> 'players';
    v_provisional := true;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'cast_id', c.id,
             'seq', c.seq,
             'card_name', sc.name,
             'caster_player_id', c.caster_id,
             'target_player_id', c.target_player_id,
             'target_pending', c.target_pending,
             'effect_kind', c.effect_kind,
             -- A cast attached to a reaction window is a reaction; everything
             -- else was armed during the pre-roll (declare-in) window.
             'phase', case when c.reaction_window_id is not null then 'reaction' else 'preroll' end,
             'negated', coalesce(c.negated, false),
             'redirected_to_cast_id', c.redirected_to_cast_id,
             -- Coarse live state for the cast strip. Once the round leaves
             -- 'open' every armed pre-roll cast is committed (on the stack);
             -- a reaction cast is on the stack the moment it exists. The
             -- renderer overrides this with the resolved outcome once a Trace
             -- is present.
             'on_stack', (c.reaction_window_id is not null) or (v_status <> 'open')
           )
           order by c.seq
         ), '[]'::jsonb)
    into v_casts
    from public.spell_casts c
    join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
    join public.spell_cards sc on sc.id = sdi.card_id
   where c.round_id = p_round_id;

  -- Issue #406: the round's revealed rolls, every layer, flat (the client
  -- groups them) -- only layers whose rolls are all in, the same withholding
  -- rule get_round_layer_history applies, so a layer never leaks mid-roll.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'player_id', r.player_id, 'layer', r.layer, 'value', r.value,
             'modifier_snapshot', r.modifier_snapshot,
             'discarded_value', r.discarded_value,
             'entered_by_admin', r.entered_by_admin)
           order by r.layer, r.player_id
         ), '[]'::jsonb)
    into v_layers
    from public.rolls r
   where r.round_id = p_round_id
     and (
       select count(*) from public.rolls r2
        where r2.round_id = p_round_id and r2.layer = r.layer
     ) >= public.count_expected_layer_rollers(p_round_id, r.layer);

  -- Issue #406: who took part in each tie-break layer. A player tied at layer
  -- N exactly when they are in layer N+1's set -- the Reroll Chain reads tie
  -- membership from here instead of re-judging the tie.
  select coalesce(jsonb_agg(
           jsonb_build_object('layer', rlp.layer, 'player_id', rlp.player_id)
           order by rlp.layer, rlp.player_id
         ), '[]'::jsonb)
    into v_layer_participants
    from public.round_layer_participants rlp
   where rlp.round_id = p_round_id;

  return jsonb_build_object(
    'resolved', v_status = 'resolved',
    -- "tie" once the round has any reroll-layer roll: layer 0 tied and the
    -- brewer was settled by tie-break rolls, where no spells or reactions
    -- apply (issue #219) -- the Recap ends at the tie. null while still live.
    'layer_zero_outcome', case
      when v_status <> 'resolved' then null
      when exists (
        select 1 from public.rolls
         where round_id = p_round_id and layer > 0
      ) then 'tie'
      else 'brewer'
    end,
    'trace', v_trace,
    -- Issue #407: the layer-0 Resolution Summary resolve_round stored beside
    -- the Trace. null for a round resolved before it existed (the row renders
    -- degraded) or not yet resolved. Issue #409: while provisional, the trace
    -- and players are the dry run's -- "so far, reactions pending".
    'players', v_summary,
    'provisional', v_provisional,
    'casts', v_casts,
    -- Issue #352: the retained Recap payload of every scrapped replay
    -- generation, oldest first (generation 0 is the original attempt). [] for
    -- a round that was never replayed. The client renders each as a collapsed
    -- generation-0 Round Recap disclosure under generation 1's headline.
    'scrapped_generations', v_scrapped,
    'layers', v_layers,
    'layer_participants', v_layer_participants
  );
end;
$$;

revoke execute on function public.get_round_recap(uuid) from public, anon;
grant execute on function public.get_round_recap(uuid) to authenticated;

comment on function public.get_round_recap(uuid) is
  'Issue #314 (Round Recap / the Ledger) + #352: room-member-gated read '
  'returning { resolved, layer_zero_outcome, trace, casts:[{ cast_id, seq, '
  'card_name, caster_player_id, target_player_id, target_pending, effect_kind, '
  'phase, negated, redirected_to_cast_id, on_stack }], scrapped_generations } '
  'for one round. trace is the persisted rounds.resolution_trace ([] until '
  'resolved); layer_zero_outcome is ''tie'' when tie-break layers decided the '
  'round; casts carries phase and coarse live state for the cast strip, with '
  'resolved per-cast state derived client-side from the Trace; '
  'scrapped_generations is rounds.scrapped_generations verbatim ([] when the '
  'round was never replayed), each entry a generation-0 Recap payload. '
  'Issue #407: players is rounds.resolution_summary (null before resolution '
  'or for a pre-summary round). Issue #409: for a live layer-0 round whose '
  'rolls are complete, trace and players come from the non-persisting '
  '_rr_resolve dry run and provisional is true (the Provisional Recap); '
  'otherwise provisional is false. Readable by any member of the round''s room. '
  'Issue #406: layers is every fully-rolled layer''s rolls (flat, the same '
  'withholding rule as get_round_layer_history) and layer_participants is '
  'round_layer_participants -- tie membership for the Reroll Chain.';
