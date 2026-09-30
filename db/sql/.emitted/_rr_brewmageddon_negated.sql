-- _rr_brewmageddon_negated
--
-- Whether a Brewmageddon cast is negated right now: its own flag (a
-- resolved round), or a live, successful, un-countered contested_negate on
-- its cast group in the reaction stack (the same derivation resolve_round
-- Phase 1 applies, read before the round resolves).
create or replace function public._rr_brewmageddon_negated(p_cast_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select negated from public.spell_casts where id = p_cast_id), false)
      or exists (
        select 1
          from public.spell_casts bm
          cross join lateral public._rr_cast_log_resolution(bm.round_id) r
         where bm.id = p_cast_id
           and r.victim_group = bm.card_instance_id
           and r.counter_kind = 'contested_negate'
           and r.counter_succeeded
           and not r.counter_negated
           and not r.counter_backfired
      );
$$;

revoke execute on function public._rr_brewmageddon_negated(uuid) from public, anon, authenticated;
