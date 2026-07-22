-- Stall-timeout enforcement (issue #21). A fixed ~2-minute code constant
-- (STALL_TIMEOUT_MS, src/lib/game/stallTimeout.ts — deliberately not
-- duplicated here in SQL) is checked lazily on read
-- (src/app/rounds/stallEnforcement.ts, invoked from src/app/page.tsx on
-- every render — there's no cron/worker anywhere in this app) against the
-- timestamps this migration adds. SQL's job is only to (a) expose the
-- timestamps needed to compute elapsed-since for each of the three stall
-- points, and (b) apply a mutation the caller has already decided on
-- (cancel / exclude) — the same "SQL persists what the caller already
-- computed" trust boundary as advance_round_layer/resolve_round (0007).

-- When declarations closed and rolling began — the layer-0 stall clock's
-- start time, distinct from started_at (the declare-window stall's clock).
alter table public.rounds add column if not exists closed_at timestamptz;

create or replace function public.close_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_started_by text;
  v_declared_count integer;
begin
  v_player_id := public.current_player_id();

  select status, started_by into v_status, v_started_by
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'close_round: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'close_round: round is not open';
  end if;

  if v_started_by <> v_player_id then
    raise exception 'close_round: only the round starter can close declarations';
  end if;

  select count(*) into v_declared_count
    from public.round_participants
   where round_id = p_round_id;

  if v_declared_count < 2 then
    raise exception 'close_round: at least 2 players must declare in before closing';
  end if;

  update public.rounds set status = 'closed', closed_at = now() where id = p_round_id;
end;
$$;

-- Exclusion marker: a stalled participant is never deleted —
-- round_participants/round_layer_participants stay append-only, same as
-- before #21 — they're marked excluded instead, so history ("who
-- declared/entered this layer") stays intact while is_expected_layer_roller
-- and the layer-completion count stop waiting on them.
alter table public.round_participants add column if not exists excluded_at timestamptz;
alter table public.round_layer_participants add column if not exists excluded_at timestamptz;

-- When a tied player's reroll layer became current — the layer-N stall
-- clock's start time (layer 0's equivalent is rounds.closed_at above).
alter table public.round_layer_participants add column if not exists entered_at timestamptz not null default now();

-- Re-defined to exclude stalled-out participants: an excluded player is no
-- longer expected to roll, so submit_roll rejects a late roll from them and
-- get_current_layer_rolls_if_complete stops waiting on them.
create or replace function public.is_expected_layer_roller(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 then
    return exists (
      select 1 from public.round_participants
       where round_id = p_round_id and player_id = p_player_id and excluded_at is null
    );
  end if;

  return exists (
    select 1 from public.round_layer_participants
     where round_id = p_round_id and layer = p_layer and player_id = p_player_id
       and excluded_at is null
  );
end;
$$;

create or replace function public.get_current_layer_rolls_if_complete(p_round_id uuid)
returns table (layer integer, player_id text, value integer, modifier_snapshot integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_layer integer;
  v_expected_count integer;
  v_roll_count integer;
begin
  v_player_id := public.current_player_id();

  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_current_layer_rolls_if_complete: round not found';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'get_current_layer_rolls_if_complete: caller is not expected to roll in the current layer';
  end if;

  if v_layer = 0 then
    select count(*) into v_expected_count
      from public.round_participants
     where round_id = p_round_id and excluded_at is null;
  else
    select count(*) into v_expected_count
      from public.round_layer_participants
     where round_id = p_round_id and layer = v_layer and excluded_at is null;
  end if;

  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = v_layer;

  if v_roll_count < v_expected_count then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

-- Who's already rolled the round's current layer, ids only (never roll
-- values — those stay behind the "hidden until revealed" rule enforced by
-- rolls' own RLS policy). This is the one piece of information the
-- stall-timeout checker needs that RLS wouldn't otherwise give a caller who
-- isn't themselves an expected roller of the current layer (e.g. a pure
-- spectator's device is just as entitled to notice a stalled round as a
-- participant's is) — deliberately broader than
-- get_current_layer_rolls_if_complete's gate for that reason.
create or replace function public.get_current_layer_roller_ids(p_round_id uuid)
returns table (player_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_layer integer;
begin
  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_current_layer_roller_ids: round not found';
  end if;

  return query
    select r.player_id from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_current_layer_roller_ids(uuid) from public, anon;
grant execute on function public.get_current_layer_roller_ids(uuid) to authenticated;

-- Same completeness gate as get_current_layer_rolls_if_complete, but no
-- caller-identity gate: stall-timeout enforcement calls this immediately
-- after excluding the layer's stalled non-rollers, at which point whoever's
-- page load triggered the check may be a pure spectator of this layer (e.g.
-- someone who already won outright at layer 0 and isn't part of the layer-1
-- tie). That's safe to allow here specifically because the completeness
-- gate is unchanged — this still can't return anything before the layer is
-- genuinely done — and the moment it does return rows, resolution
-- immediately broadcasts them to the whole room anyway (round-revealed /
-- layer-tied), so no caller sees anything here that isn't about to become
-- public regardless of who asked.
create or replace function public.get_completed_layer_rolls_for_stall_resolution(p_round_id uuid)
returns table (layer integer, player_id text, value integer, modifier_snapshot integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_layer integer;
  v_expected_count integer;
  v_roll_count integer;
begin
  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_completed_layer_rolls_for_stall_resolution: round not found';
  end if;

  if v_layer = 0 then
    select count(*) into v_expected_count
      from public.round_participants
     where round_id = p_round_id and excluded_at is null;
  else
    select count(*) into v_expected_count
      from public.round_layer_participants
     where round_id = p_round_id and layer = v_layer and excluded_at is null;
  end if;

  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = v_layer;

  if v_roll_count < v_expected_count then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) from public, anon;
grant execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) to authenticated;

-- Cancels a stalled round. Idempotent and doesn't re-check elapsed time
-- itself — the caller (src/app/rounds/stallEnforcement.ts) has already
-- compared the relevant timestamp against STALL_TIMEOUT_MS using its own
-- (test-injectable) clock; SQL's job is only to apply the transition once
-- decided, same trust boundary as advance_round_layer/resolve_round. A
-- no-op (not an error) if the round has already left 'open'/'closed' by the
-- time this runs, since two stalled devices' lazy checks can race — the
-- rounds_one_active_per_room index is untouched by a no-op, so this can't
-- accidentally free up the room twice.
create or replace function public.cancel_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rounds
     set status = 'cancelled'
   where id = p_round_id
     and status in ('open', 'closed');
end;
$$;

revoke execute on function public.cancel_round(uuid) from public, anon;
grant execute on function public.cancel_round(uuid) to authenticated;

-- Excludes a stalled participant from a round's given layer — marks
-- excluded_at rather than deleting, same rationale as the column comment
-- above. Same "caller already decided, SQL applies it" trust boundary as
-- cancel_round. Idempotent.
create or replace function public.exclude_round_participant(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 then
    update public.round_participants
       set excluded_at = now()
     where round_id = p_round_id and player_id = p_player_id and excluded_at is null;
  else
    update public.round_layer_participants
       set excluded_at = now()
     where round_id = p_round_id and layer = p_layer and player_id = p_player_id
       and excluded_at is null;
  end if;
end;
$$;

revoke execute on function public.exclude_round_participant(uuid, text, integer) from public, anon;
grant execute on function public.exclude_round_participant(uuid, text, integer) to authenticated;
