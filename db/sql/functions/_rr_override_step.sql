-- _rr_override_step(integer, uuid, text, text, text, text, jsonb) -> jsonb
--
-- Issue #451: the `tea_maker_override` Resolution Trace step, built in one
-- place for every override outcome _rr_select_tea_maker records -- the
-- winning override (after `brewer` / `brewer (no modifier gain)`) and an
-- override that can't act (after `no effect` / `condition not met`, with an
-- `override_reason` in p_extra). before is always status `pending`; the
-- source cast is the override's own cast row.
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_override_step(
  p_index integer, p_cast_id uuid, p_card_name text, p_caster_id text,
  p_target text, p_after text, p_extra jsonb
)
returns jsonb
language sql
immutable
as $$
  select public._rr_trace_step(
    p_index,
    'tea_maker_override',
    jsonb_build_object(
      'cast_id', to_jsonb(p_cast_id),
      'active_effect_id', null,
      'card_name', to_jsonb(p_card_name),
      'caster_player_id', to_jsonb(p_caster_id)
    ),
    p_target,
    jsonb_build_object('type', 'status', 'value', 'pending'),
    jsonb_build_object('type', 'status', 'value', p_after),
    p_extra
  );
$$;

revoke execute on function public._rr_override_step(integer, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

comment on function public._rr_override_step(integer, uuid, text, text, text, text, jsonb) is
  'Issue #451: the tea_maker_override Resolution Trace step (before pending -> after p_after, extras merged), the one builder _rr_select_tea_maker uses for a winning or inert override. Internal.';
