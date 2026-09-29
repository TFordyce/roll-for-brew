-- get_round_recap(p_round_id uuid) -> jsonb
--
-- Round Recap read surface (issue #314, "the Ledger") + round-replay follow-up
-- (issue #352): one participant-gated RPC that hands the client everything the
-- Recap renderer needs in a single round trip -- the persisted Resolution Trace,
-- the round's full cast list with each cast's phase and coarse live state, and
-- every scrapped replay generation's retained Recap payload.
--
-- Additive and read-only: no schema change, no behaviour change to any other
-- RPC. spell_casts still has no direct SELECT policy (0019), so this
-- SECURITY DEFINER function is the read path, same narrow-scope convention as
-- get_round_modifier_effects.
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
  v_trace jsonb;
  v_summary jsonb;
  v_casts jsonb;
  v_scrapped jsonb;
  v_layers jsonb;
  v_layer_participants jsonb;
begin
  v_player_id := public.current_player_id(p_round_id);

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'get_round_recap: caller is not a participant in this round';
  end if;

  select r.status,
         coalesce(r.resolution_trace, '[]'::jsonb),
         r.resolution_summary,
         coalesce(r.scrapped_generations, '[]'::jsonb)
    into v_status, v_trace, v_summary, v_scrapped
    from public.rounds r
   where r.id = p_round_id;

  if v_status is null then
    raise exception 'get_round_recap: round not found';
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
    -- degraded) or not yet resolved.
    'players', v_summary,
    'provisional', false,
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
  'Issue #314 (Round Recap / the Ledger) + #352: participant-gated read '
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
  'or for a pre-summary round); provisional is false. '
  'Issue #406: layers is every fully-rolled layer''s rolls (flat, the same '
  'withholding rule as get_round_layer_history) and layer_participants is '
  'round_layer_participants -- tie membership for the Reroll Chain.';
