-- Round replay follow-up (issue #352, spec #302 §11): surface a replayed
-- round's retained generation-0 Recap payload to the client so RoundReveal can
-- headline generation 1 and hold generation 0's own Round Recap in a collapsed
-- disclosure.
--
-- Migration 0090 already snapshots every scrapped generation into
-- rounds.scrapped_generations -- an append-only jsonb array, one entry per
-- generation: { generation, brewer_id, cups_made, brewer_modifier_gain,
-- resolved_at, resolution_trace, rolls, layer_participants }. Nothing reads it
-- yet. This migration re-emits get_round_recap (0086) unchanged except for one
-- extra passthrough key, `scrapped_generations`, so the single Recap round trip
-- also carries the scrapped generations. No schema change, no behaviour change
-- to any other RPC; still the security-definer read path over spell_casts
-- (0086 header).
--
-- Migration number: master's highest is 0077; the rebuild branch adds
-- 0078-0090. This is 0091. Issue #351 (roll-domain ward carry-over) is being
-- implemented concurrently on rebuild/effect-resolver and will also want a
-- number here -- whichever lands second renumbers to 0092. Re-check at the
-- integrate step (branching strategy in #303).

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
  v_casts jsonb;
  v_scrapped jsonb;
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
         coalesce(r.scrapped_generations, '[]'::jsonb)
    into v_status, v_trace, v_scrapped
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
    'casts', v_casts,
    -- Issue #352: the retained Recap payload of every scrapped replay
    -- generation, oldest first (generation 0 is the original attempt). [] for
    -- a round that was never replayed. The client renders each as a collapsed
    -- generation-0 Round Recap disclosure under generation 1's headline.
    'scrapped_generations', v_scrapped
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
  'round was never replayed), each entry a generation-0 Recap payload.';
