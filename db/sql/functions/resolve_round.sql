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
  'Authoritative layer-0 outcome resolver (issues #305-#311 / #316-#319 / #321 / #342 / #344 / #351 / #289, ADR 0005). Locks the closed round, runs the Resolver pipeline (_rr_resolve_eval, issue #404) and persists rounds.resolution_trace and rounds.resolution_summary at both layer-0 exits (tie and brewer); layer > 0 bypasses all spell logic and persists nothing (issue #219). Returns { outcome, layer, brewer_id, brewer_source, tied_player_ids, cups_made, modifier_gain, no_modifier_gain, trace, players }. Deterministic and idempotent over its inputs: the Cast-Log / modifier caches it maintains are rewritten identically on a re-run. The non-persisting twin is _rr_resolve (ADR 0007).';

-- resolve_round(p_round_id uuid, p_brewer_id text, p_cups_made integer,
--               p_modifier_gain integer) -> void
--
-- The resolution write (issue #425): marks the closed round resolved and
-- applies the Tea Maker's modifier gain -- null = cups_made, 0 = none, any
-- other value as given -- to rounds.brewer_modifier_gain and the live
-- room_players.modifier. _rr_base_modifier sums brewer_modifier_gain (#395),
-- so a 0 or doubled gain survives every recompute. finalize_layer commits
-- through it. No default on p_modifier_gain, so a 3-arg call still binds the
-- boolean overload below and never becomes ambiguous.
--
-- resolve_round(uuid, text, integer, boolean) is the old yes/no, kept only as
-- a compat alias (admin_backfill_round's 3-arg call): true -> 0, false -> null.

create or replace function public.resolve_round(
  p_round_id uuid, p_brewer_id text, p_cups_made integer, p_modifier_gain integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_participant_count integer;
  v_expected_layer_count integer;
  v_roll_count integer;
  v_gain integer;
begin
  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = p_brewer_id
  ) then
    raise exception 'resolve_round: brewer is not a participant in this round';
  end if;

  select count(*) into v_participant_count
    from public.round_participants
   where round_id = p_round_id;

  v_expected_layer_count := public.count_expected_layer_rollers(p_round_id, v_layer);

  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = v_layer;

  if v_roll_count < v_expected_layer_count then
    raise exception 'resolve_round: not all participants have rolled yet';
  end if;

  if p_cups_made <> v_participant_count then
    raise exception 'resolve_round: cups_made must equal the round''s participant count';
  end if;

  v_gain := coalesce(p_modifier_gain, p_cups_made);

  update public.rounds
     set status = 'resolved',
         brewer_id = p_brewer_id,
         cups_made = p_cups_made,
         brewer_modifier_gain = v_gain,
         resolved_at = now()
   where id = p_round_id;

  if v_gain <> 0 then
    update public.room_players
       set modifier = modifier + v_gain
     where room_id = v_room_id and player_id = p_brewer_id;
  end if;
end;
$$;

revoke execute on function public.resolve_round(uuid, text, integer, integer) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer, integer) to authenticated;

comment on function public.resolve_round(uuid, text, integer, integer) is
  'Issue #425: the resolution write. Marks the closed round resolved with '
  'p_brewer_id and p_cups_made, and applies the tea-making modifier gain: '
  'p_modifier_gain null -> cups_made, 0 -> none, any other value as given. '
  'Writes rounds.brewer_modifier_gain and adds the same amount to '
  'room_players.modifier. Committed by finalize_layer from resolve_round(uuid)''s '
  'modifier_gain.';

create or replace function public.resolve_round(
  p_round_id uuid, p_brewer_id text, p_cups_made integer, p_no_modifier_gain boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.resolve_round(
    p_round_id, p_brewer_id, p_cups_made,
    case when p_no_modifier_gain then 0 else null end::integer);
end;
$$;

revoke execute on function public.resolve_round(uuid, text, integer, boolean) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer, boolean) to authenticated;

comment on function public.resolve_round(uuid, text, integer, boolean) is
  'Compat alias (issue #425) for resolve_round(uuid, text, integer, integer): '
  'p_no_modifier_gain true -> modifier gain 0, false -> null (cups_made).';
