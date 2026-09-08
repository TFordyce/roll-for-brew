-- _rr_trace_step(integer, text, jsonb, text, jsonb, jsonb, jsonb) -> jsonb
--
-- One Resolution Trace step object with extra top-level keys merged in
-- (the 7-arg form). The 6-arg base form it delegates to is single-
-- definition and stays in migration 0078. Verbatim from migration 0080.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_trace_step(
  p_index integer, p_display_kind text, p_source_cast jsonb,
  p_target_player text, p_before jsonb, p_after jsonb, p_extra jsonb
)
returns jsonb
language sql
immutable
as $$
  select public._rr_trace_step(
           p_index, p_display_kind, p_source_cast, p_target_player, p_before, p_after
         ) || coalesce(p_extra, '{}'::jsonb);
$$;

revoke execute on function public._rr_trace_step(integer, text, jsonb, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public._rr_trace_step(integer, text, jsonb, text, jsonb, jsonb, jsonb) to authenticated;
