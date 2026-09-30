-- _rr_heist_trace(p_round_id uuid, p_start_index integer) -> jsonb
--
-- Tea Heist's Resolution Trace steps (issue #438): one `card_heist` step per
-- Heist, from _rr_heist_outcomes, numbered from p_start_index. The resolver's
-- final phase -- _rr_resolve_eval appends these at both layer-0 exits (tie
-- and brewer), after brewer selection. Status-only: before `held`, after
-- `moved` | `fizzled` | `countered`; `outcome` is `applied` only for a move,
-- and a fizzle carries `heist_reason`. The step never names the stolen card:
-- a held card is private to its holder.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_heist_trace(p_round_id uuid, p_start_index integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
           public._rr_trace_step(
             p_start_index + (h.ord - 1)::integer,
             'card_heist',
             jsonb_build_object(
               'cast_id', to_jsonb(h.cast_id),
               'active_effect_id', null,
               'card_name', to_jsonb(h.card_name),
               'caster_player_id', to_jsonb(h.caster_id)
             ),
             h.victim_id,
             jsonb_build_object('type', 'status', 'value', 'held'),
             jsonb_build_object('type', 'status', 'value', h.outcome),
             jsonb_strip_nulls(jsonb_build_object(
               'outcome', case when h.outcome = 'moved' then 'applied' else 'no-op' end,
               'heist_reason', h.reason
             ))
           ) order by h.ord
         ), '[]'::jsonb)
    from public._rr_heist_outcomes(p_round_id) with ordinality as h(
           cast_id, caster_id, victim_id, instance_id, card_name, outcome, reason, ord);
$$;

revoke execute on function public._rr_heist_trace(uuid, integer) from public, anon, authenticated;

comment on function public._rr_heist_trace(uuid, integer) is
  'Issue #438 (Tea Heist): the resolver''s final-phase card_heist Trace steps, one per Heist (status held -> moved | fizzled | countered, heist_reason on a fizzle), numbered from p_start_index. Decides nothing itself -- reads _rr_heist_outcomes. Internal.';
