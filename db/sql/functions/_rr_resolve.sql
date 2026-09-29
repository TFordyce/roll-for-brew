-- _rr_resolve(p_round_id uuid) -> jsonb
--
-- The non-persisting resolver evaluation (issue #404, ADR 0007): returns the
-- same object resolve_round(uuid) returns -- outcome, Resolution Trace and
-- Resolution Summary -- and leaves NOTHING behind. get_round_recap calls it to
-- build the Provisional Recap, which means it runs on viewer page renders.
--
-- MUST STAY WRITE-FREE IN EFFECT. The pipeline body (_rr_resolve_eval)
-- maintains Cast-Log and modifier caches its own later phases read back, so it
-- cannot run without writing. This function therefore runs it inside a
-- PL/pgSQL exception block and always raises out of it: the block's implicit
-- savepoint rolls every write back, while the result survives in a local
-- variable. The only lasting side effects are sequence advances (spell_casts
-- seq / ids of rolled-back copy and tick rows), which are gap-tolerant. Do not
-- add anything here, or to _rr_resolve_eval, that escapes a rollback
-- (dblink, pg_notify, advisory session locks, sequence-dependent logic).
--
-- The dry run does not roll the Calami-Tea tick die (see _rr_resolve_eval):
-- its dice_tick step carries rolled = null and moves nothing.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_resolve(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  begin
    v_out := public._rr_resolve_eval(p_round_id, true);
    raise exception using errcode = 'RRDRY', message = '_rr_resolve: dry-run rollback';
  exception
    when sqlstate 'RRDRY' then
      null;   -- every write inside the block is rolled back; v_out survives
  end;

  return v_out;
end;
$$;

revoke execute on function public._rr_resolve(uuid) from public, anon, authenticated;
-- The Trace-snapshot harness drives it directly with the service role.
grant execute on function public._rr_resolve(uuid) to service_role;

comment on function public._rr_resolve(uuid) is
  'Issue #404 (ADR 0007): non-persisting resolver evaluation. Returns what resolve_round(uuid) returns ({ outcome, layer, brewer_id, brewer_source, tied_player_ids, cups_made, no_modifier_gain, trace, players }) and leaves no writes: the pipeline runs inside a subtransaction that is always rolled back. Must stay write-free -- get_round_recap runs it on viewer page renders for the Provisional Recap. Does not roll the Calami-Tea tick die. Internal.';
