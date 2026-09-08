-- _rr_cast_log_resolution(uuid) -> setof record
--
-- Recursive, memoised negate / redirect / backfire derivation over a
-- round's reaction stack, purely from recorded cast_inputs. resolve_round
-- Phase 1 consumes this. Verbatim from migration 0081 (leading
-- `drop function if exists` kept: the source uses bare `create function`).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

drop function if exists public._rr_cast_log_resolution(uuid);
create function public._rr_cast_log_resolution(p_round_id uuid)
returns table (
  counter_cast_id uuid,
  counter_kind text,
  counter_seq bigint,
  counter_negated boolean,
  counter_succeeded boolean,
  counter_backfired boolean,
  counter_dc_d20 integer,
  counter_dc integer,
  counter_caster text,
  victim_group uuid,
  victim_cast_id uuid,
  victim_orig_target text,
  victim_caster text,
  redirect_to text
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_counters jsonb := '[]'::jsonb;
  v_n integer;
  v_idx integer;
  v_pass integer;
  v_changed boolean;
  v_c jsonb;
  v_neg boolean;
begin
  -- Gather every contested_negate / redirect cast in the round together with
  -- the cast it targets (parent_cast_id), that cast's group
  -- (card_instance_id) and original target, and whether its contest passed.
  -- Ordered by seq so the fixpoint below walks the stack deterministically.
  select coalesce(jsonb_agg(entry order by (entry->>'seq')::bigint), '[]'::jsonb)
    into v_counters
    from (
      select jsonb_build_object(
               'counter_cast_id', c.id,
               'kind', c.effect_kind,
               'seq', c.seq,
               'caster_id', c.caster_id,
               'target_group', tgt.card_instance_id,
               'target_cast_id', c.parent_cast_id,
               'own_group', c.card_instance_id,
               'victim_orig_target', tgt.target_player_id,
               'victim_caster', tgt.caster_id,
               'dc_d20', (c.cast_inputs->>'dc_d20')::int,
               'dc', case
                 when c.effect_kind = 'redirect' then null
                 else coalesce(
                   (c.cast_inputs->>'dc')::int,
                   public._rr_tier_default_dc(tcard.tier))
               end,
               'has_backfire', coalesce(c.cast_inputs ? 'backfire', false),
               'succeeded', case
                 when c.effect_kind = 'redirect' then true
                 else coalesce(
                   (c.cast_inputs->>'dc_d20')::int >= coalesce(
                     (c.cast_inputs->>'dc')::int,
                     public._rr_tier_default_dc(tcard.tier)),
                   false)
               end,
               'is_negated', false
             ) as entry
        from public.spell_casts c
        join public.spell_casts tgt on tgt.id = c.parent_cast_id
        join public.spell_deck_instances tsdi on tsdi.id = tgt.card_instance_id
        join public.spell_cards tcard on tcard.id = tsdi.card_id
       where c.round_id = p_round_id
         and c.effect_kind in ('contested_negate', 'redirect')
    ) s;

  v_n := jsonb_array_length(v_counters);
  if v_n = 0 then
    return;
  end if;

  -- Fixpoint: a counter is negated iff some higher-seq contested_negate
  -- targets ITS OWN cast group, succeeded, and is not itself negated. Bounded
  -- at 2*n + 2 passes as a safety net; converges because every counter
  -- targets a strictly-lower seq.
  for v_pass in 1 .. (2 * v_n + 2) loop
    v_changed := false;
    for v_idx in 0 .. v_n - 1 loop
      v_c := v_counters -> v_idx;
      v_neg := exists (
        select 1
          from jsonb_array_elements(v_counters) d
         where d.value->>'kind' = 'contested_negate'
           and (d.value->>'target_group') = (v_c->>'own_group')
           and (d.value->>'seq')::bigint > (v_c->>'seq')::bigint
           and (d.value->>'succeeded')::boolean
           and not (d.value->>'is_negated')::boolean
      );
      if v_neg is distinct from (v_c->>'is_negated')::boolean then
        v_counters := jsonb_set(v_counters, array[v_idx::text, 'is_negated'], to_jsonb(v_neg));
        v_changed := true;
      end if;
    end loop;
    exit when not v_changed;
  end loop;

  for v_idx in 0 .. v_n - 1 loop
    v_c := v_counters -> v_idx;
    counter_cast_id   := (v_c->>'counter_cast_id')::uuid;
    counter_kind      := v_c->>'kind';
    counter_seq       := (v_c->>'seq')::bigint;
    counter_negated   := (v_c->>'is_negated')::boolean;
    counter_succeeded := (v_c->>'succeeded')::boolean;
    -- Backfire: a Saving Steep-style counter (it recorded a cast_inputs.backfire
    -- payload at cast time -- only a natural 1 does) that is not itself
    -- negated. A backfired counter never negates its victim.
    counter_backfired := (v_c->>'has_backfire')::boolean
                         and not (v_c->>'is_negated')::boolean;
    counter_dc_d20    := (v_c->>'dc_d20')::int;
    counter_dc        := (v_c->>'dc')::int;
    counter_caster    := v_c->>'caster_id';
    victim_group      := (v_c->>'target_group')::uuid;
    victim_cast_id    := (v_c->>'target_cast_id')::uuid;
    victim_orig_target := v_c->>'victim_orig_target';
    victim_caster     := v_c->>'victim_caster';
    -- A live (non-negated) redirect reflects the reactor's own exposure --
    -- the single targeted row -- back onto the countered cast's ORIGINAL
    -- caster (spec §8: "onto the original caster"; classic Mug Mirror).
    redirect_to := case
      when v_c->>'kind' = 'redirect' and not (v_c->>'is_negated')::boolean
        then v_c->>'victim_caster'
      else null
    end;
    return next;
  end loop;
end;
$$;

revoke execute on function public._rr_cast_log_resolution(uuid) from public, anon;
grant execute on function public._rr_cast_log_resolution(uuid) to authenticated;

comment on function public._rr_cast_log_resolution(uuid) is
  'Issue #307/#308: recursive, memoised negate / redirect / backfire derivation over a round''s reaction stack, purely from recorded cast_inputs. One row per contested_negate / redirect cast: whether it is itself negated (counter-of-counter to any depth), whether its contest succeeded, whether it BACKFIRED (natural 1 on a Saving Steep-style counter), the recorded dc_d20 / effective dc, the specific targeted spell_casts.id and its group, and (for redirect) the player its effect moves onto. resolve_round Phase 1 consumes this.';
