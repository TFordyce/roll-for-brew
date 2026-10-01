-- _rr_draw_redirect_trace(p_round_id uuid, p_start_index integer) -> jsonb
--
-- Marked for Brew's Resolution Trace steps (issue #436): `draw_redirect`
-- steps, numbered from p_start_index. Appended by _rr_resolve_eval's final
-- phase, after Tea Heist's. Status-only, target = the marked player, source
-- cast = the mark's cast (its caster is the beneficiary):
--   * `marked`     -- a non-negated Marked for Brew cast in this round placed
--                     its mark (outcome `applied`). A countered cast gets
--                     Phase 1's negated-victim step instead, so none here;
--   * `redirected` -- a mark fired on a crit this round and the draw went to
--                     the beneficiary (outcome `applied`). The mark's cast
--                     may be from an earlier round;
--   * `fizzled`    -- a mark fired this round but the beneficiary already had
--                     a pending draw, so the target kept theirs (`no-op`).
-- Fired steps read what _apply_crit_redirect recorded at roll time
-- (cast_inputs.consumed_by_round / draw_redirect_outcome), so they decide
-- nothing. A crit in a tie-break layer fires after the layer-0 Trace is
-- written, so its step does not appear. Saucerer's Apprentice copies
-- (cast_inputs.is_copy) project no mark and are left out.
--
-- Issue #437: every step carries `redirect_trigger`, the mark's trigger
-- (`next_crit` for Marked for Brew, `next_draw` for Stale Biscuit), so the
-- Recap can say which draw the mark takes. A `next_draw` mark fires at draw
-- time, after its round's Trace is written, and records consumed_by_draw
-- rather than consumed_by_round -- so only its `marked` step appears.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_draw_redirect_trace(p_round_id uuid, p_start_index integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with steps as (
    -- marks placed this round
    select c.id as cast_id, 'marked' as outcome, 0 as kind_order
      from public.spell_casts c
     where c.round_id = p_round_id
       and c.effect_kind = 'draw_redirect'
       and c.target_player_id is not null
       and not coalesce(c.negated, false)
       and not coalesce(c.cast_inputs ? 'is_copy', false)
    union all
    -- marks that fired this round
    select c.id, c.cast_inputs ->> 'draw_redirect_outcome', 1
      from public.spell_casts c
     where c.effect_kind = 'draw_redirect'
       and c.cast_inputs ->> 'consumed_by_round' = p_round_id::text
  )
  select coalesce(jsonb_agg(
           public._rr_trace_step(
             p_start_index + (s.ord - 1)::integer,
             'draw_redirect',
             jsonb_build_object(
               'cast_id', to_jsonb(s.cast_id),
               'active_effect_id', null,
               'card_name', to_jsonb(s.card_name),
               'caster_player_id', to_jsonb(s.caster_id)
             ),
             s.target_player_id,
             jsonb_build_object('type', 'status', 'value', case when s.outcome = 'marked' then null else 'marked' end),
             jsonb_build_object('type', 'status', 'value', s.outcome),
             jsonb_build_object(
               'outcome', case when s.outcome = 'fizzled' then 'no-op' else 'applied' end,
               'redirect_trigger', s.redirect_trigger
             )
           ) order by s.ord
         ), '[]'::jsonb)
    from (
      select steps.outcome, c.id as cast_id, c.caster_id, c.target_player_id, sc.name as card_name,
             c.effect_params ->> 'trigger' as redirect_trigger,
             row_number() over (order by steps.kind_order, c.seq, c.id) as ord
        from steps
        join public.spell_casts c on c.id = steps.cast_id
        join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
    ) s;
$$;

revoke execute on function public._rr_draw_redirect_trace(uuid, integer) from public, anon, authenticated;

comment on function public._rr_draw_redirect_trace(uuid, integer) is
  'Issue #436 (Marked for Brew): the resolver''s final-phase draw_redirect Trace steps -- marked (a mark cast this round), redirected / fizzled (a mark that fired on a crit this round, read from the cast_inputs _apply_crit_redirect wrote), numbered from p_start_index; (#437) each carries redirect_trigger (next_crit / next_draw). Decides nothing. Internal.';
