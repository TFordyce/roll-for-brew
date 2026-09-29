-- resolve_round(p_round_id uuid) -> jsonb
--
-- Authoritative round resolution: locks the closed round, runs the Resolver
-- pipeline (_rr_resolve_eval) and persists its Resolution Trace and
-- Resolution Summary (issue #407) at the two layer-0 exits (tie and brewer).
-- Layer > 0 persists nothing (issue #219).
-- Issue #404 (ADR 0007) moved the pipeline body into _rr_resolve_eval so the
-- non-persisting _rr_resolve can share it; this function is the writer, and
-- only the server's round-advancement code calls it.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_out jsonb;
begin
  select status into v_status
    from public.rounds
   where id = p_round_id
     for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
  end if;

  v_out := public._rr_resolve_eval(p_round_id, false);

  if (v_out ->> 'layer')::integer = 0 then
    update public.rounds
       set resolution_trace = v_out -> 'trace',
           -- issue #407: the Resolution Summary, beside the Trace (ADR 0007)
           resolution_summary = v_out -> 'players'
     where id = p_round_id;
  end if;

  return v_out;
end;
$$;

revoke execute on function public.resolve_round(uuid) from public, anon;
grant execute on function public.resolve_round(uuid) to authenticated;

comment on function public.resolve_round(uuid) is
  'Authoritative layer-0 outcome resolver (issues #305-#311 / #316-#319 / #321 / #342 / #344 / #351 / #289, ADR 0005). Locks the closed round, runs the Resolver pipeline (_rr_resolve_eval, issue #404) and persists rounds.resolution_trace and rounds.resolution_summary at both layer-0 exits (tie and brewer); layer > 0 bypasses all spell logic and persists nothing (issue #219). Returns { outcome, layer, brewer_id, brewer_source, tied_player_ids, cups_made, no_modifier_gain, trace, players }. Pure and idempotent over its inputs. The non-persisting twin is _rr_resolve (ADR 0007).';
