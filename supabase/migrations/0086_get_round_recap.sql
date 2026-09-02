-- Round Recap read surface (issue #314, "the Ledger"): a single participant-
-- gated RPC that hands the client everything the Recap renderer needs in one
-- round trip -- the persisted Resolution Trace plus the round's full cast list
-- with each cast's phase (pre-roll vs reaction window) and coarse live state
-- (armed / on-stack). Resolved state per cast is derived client-side from the
-- Trace; this RPC only has to cover the live window, where there is no Trace
-- yet.
--
-- Additive and read-only: no schema change, no behaviour change to any
-- existing RPC. spell_casts still has no direct SELECT policy (0019), so this
-- SECURITY DEFINER function is the read path, same narrow-scope convention as
-- get_round_modifier_effects.
--
-- Migration number: master's highest is 0077; the rebuild branch adds
-- 0078-0085. This is 0086. Re-check at the integrate step (branching strategy
-- in #303) and renumber to sit after master's current highest.

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
begin
  v_player_id := public.current_player_id(p_round_id);

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'get_round_recap: caller is not a participant in this round';
  end if;

  select r.status, coalesce(r.resolution_trace, '[]'::jsonb)
    into v_status, v_trace
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
    'casts', v_casts
  );
end;
$$;

revoke execute on function public.get_round_recap(uuid) from public, anon;
grant execute on function public.get_round_recap(uuid) to authenticated;

comment on function public.get_round_recap(uuid) is
  'Issue #314 (Round Recap / the Ledger): participant-gated read returning '
  '{ resolved, layer_zero_outcome, trace, casts:[{ cast_id, seq, card_name, '
  'caster_player_id, target_player_id, target_pending, effect_kind, phase, '
  'negated, redirected_to_cast_id, on_stack }] } for one round. trace is the '
  'persisted rounds.resolution_trace ([] until resolved); layer_zero_outcome '
  'is ''tie'' when tie-break layers decided the round; casts carries phase and '
  'coarse live state for the cast strip, with resolved per-cast state derived '
  'client-side from the Trace.';
