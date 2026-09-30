-- _rr_brewer_immunity_step(integer, jsonb, text, text, text) -> jsonb
--
-- Issue #428 (spec #401 F2, ADR 0005 tier 0): the `brewer_immunity`
-- Resolution Trace step for one immune player passed over by Phase 5 brewer
-- selection. p_immunity is that player's entry in the resolver's immunity map
-- ({ ae_id, caster_id, card_name, ... }); p_tier is the tier that would have
-- named them -- 'declared_number', 'tea_maker_override' or 'lowest_roller';
-- p_skipped_card_name is the declared-number or override card that was
-- passed over (null for the lowest roller). before 'brewer' -> after
-- 'immune'.
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_brewer_immunity_step(
  p_index integer, p_immunity jsonb, p_player text, p_tier text, p_skipped_card_name text
)
returns jsonb
language sql
immutable
as $$
  select public._rr_trace_step(
    p_index,
    'brewer_immunity',
    jsonb_build_object(
      'cast_id', null,
      'active_effect_id', p_immunity -> 'ae_id',
      'card_name', p_immunity -> 'card_name',
      'caster_player_id', p_immunity -> 'caster_id'
    ),
    p_player,
    jsonb_build_object('type', 'status', 'value', 'brewer'),
    jsonb_build_object('type', 'status', 'value', 'immune'),
    jsonb_build_object('immunity_tier', p_tier, 'skipped_card_name', p_skipped_card_name)
  );
$$;

revoke execute on function public._rr_brewer_immunity_step(integer, jsonb, text, text, text) from public, anon, authenticated;
