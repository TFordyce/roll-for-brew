-- Issue #411: Skip vote (CONTEXT.md). A Layer 0 reaction window closed only
-- once every eligible Reaction-card holder passed its current poll round, so a
-- holder who never responded held the round open forever: stall recovery
-- (#387) only closed a window with *zero* eligible holders.
--
-- This adds two ways to stop waiting on the players being waited on (eligible,
-- not yet passed this poll round), both of which auto-pass them and close the
-- window exactly as if they had passed:
--  - vote_skip_reaction_window: once 30 seconds have passed since the current
--    poll round started, any active Layer 0 participant who isn't being waited
--    on may vote; ceil(n/2) votes over all active participants skips.
--  - time_out_reaction_window: the stall backstop, called by
--    enforceStallTimeout (src/app/rounds/stallEnforcement.ts) once
--    STALL_TIMEOUT_MS has passed since the latest poll round started. The
--    elapsed-time check stays in the app, like every other stall RPC.
-- Closing the window only removes that one blockage; Layer finalization is
-- still the caller's advanceRound (ADR 0008).

-- When the current poll round started: set when the window opens, reset on
-- every chaining bump (_rr_reopen_or_close_reaction_poll below). opened_at
-- can't serve, because a chained Reaction cast bumps poll_round in place.
alter table public.spell_reaction_windows
  add column poll_round_started_at timestamptz not null default now();
update public.spell_reaction_windows set poll_round_started_at = opened_at;

-- Why a pass was recorded: the player's own Pass, or an auto-pass for a
-- player the table stopped waiting on (skipped by vote, or timed out). The
-- Round Recap names the auto-passed players.
alter table public.spell_reaction_passes
  add column reason text not null default 'pass'
  check (reason in ('pass', 'vote', 'timeout'));

-- One row per skip vote, scoped to one poll round the same way passes are: a
-- chaining bump leaves the previous poll round's votes behind.
create table public.spell_reaction_skip_votes (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.spell_reaction_windows (id) on delete cascade,
  poll_round integer not null,
  player_id text not null references public.players (id),
  voted_at timestamptz not null default now(),
  unique (window_id, poll_round, player_id)
);

alter table public.spell_reaction_skip_votes enable row level security;
-- No select policy: read only through get_reaction_window_skip_vote, same
-- convention as spell_reaction_passes (0021). service_role still needs the
-- table grant for admin/test code (see 0042).
grant all on public.spell_reaction_skip_votes to service_role;

-- The chaining bump (0104) now also restarts the poll round's clock, which
-- restarts both the 30-second vote grace period and the stall backstop.
create or replace function public._rr_reopen_or_close_reaction_poll(
  p_round_id uuid, p_window_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.spell_reaction_windows
     set poll_round = poll_round + 1,
         poll_round_started_at = now()
   where id = p_window_id;

  if public.count_eligible_reaction_holders(p_round_id) = 0 then
    perform public.close_reaction_window(p_window_id);
  end if;
end;
$$;

-- The players being waited on: round participants holding a usable Reaction
-- card who haven't passed the given poll round. The one definition
-- get_reaction_window_pending_players, the vote and the timeout all read.
create or replace function public._reaction_window_waiting_on(
  p_round_id uuid, p_window_id uuid, p_poll_round integer
)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select rp.player_id
    from public.round_participants rp
   where rp.round_id = p_round_id
     and public.holds_usable_reaction_card(rp.player_id)
     and not public.has_passed_reaction_poll(p_window_id, p_poll_round, rp.player_id);
$$;

revoke execute on function public._reaction_window_waiting_on(uuid, uuid, integer) from public, anon, authenticated;

-- Skip vote threshold: ceil(n/2), n = the round's active (not stall-excluded)
-- Layer 0 participants, players being waited on included.
create or replace function public._reaction_skip_threshold(p_round_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select ceil(count(*) / 2.0)::integer
    from public.round_participants
   where round_id = p_round_id and excluded_at is null;
$$;

revoke execute on function public._reaction_skip_threshold(uuid) from public, anon, authenticated;

-- Auto-passes everyone still being waited on in the window's current poll
-- round, recording why, and closes the window. Returns who was auto-passed.
-- The caller holds the window's row lock.
create or replace function public._auto_pass_reaction_window(
  p_round_id uuid, p_window_id uuid, p_reason text
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_round integer;
  v_players text[];
begin
  select poll_round into v_poll_round
    from public.spell_reaction_windows
   where id = p_window_id;

  select coalesce(array_agg(w order by w), '{}')
    into v_players
    from public._reaction_window_waiting_on(p_round_id, p_window_id, v_poll_round) w;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id, reason)
  select p_window_id, v_poll_round, unnest(v_players), p_reason
  on conflict (window_id, poll_round, player_id) do nothing;

  perform public.close_reaction_window(p_window_id);
  return v_players;
end;
$$;

revoke execute on function public._auto_pass_reaction_window(uuid, uuid, text) from public, anon, authenticated;

-- Players being waited on, now reading the shared definition above (0067
-- restated it inline).
create or replace function public.get_reaction_window_pending_players(p_round_id uuid)
returns table (player_id text, display_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_id uuid;
  v_poll_round integer;
begin
  select w.id, w.poll_round into v_window_id, v_poll_round
    from public.spell_reaction_windows w
   where w.round_id = p_round_id and w.status = 'open'
   order by w.opened_at desc
   limit 1;

  if v_window_id is null then
    return;
  end if;

  return query
    select p.id, coalesce(p.display_name, p.email)
      from public._reaction_window_waiting_on(p_round_id, v_window_id, v_poll_round) w
      join public.players p on p.id = w
     order by coalesce(p.display_name, p.email);
end;
$$;

-- Casts the caller's Skip vote on the round's open reaction window. Returns
-- true when this vote reached the threshold and closed the window. Raises:
--  RFB04 no open window (stale, same as pass_reaction_window);
--  RFB51 the 30-second grace period since the poll round started isn't over;
--  RFB52 the caller can't vote: not an active participant (a spectator or a
--        stall-excluded player), or being waited on themselves.
-- A repeat vote in the same poll round is a no-op. Honours the Acting As
-- override (ADR 0001) through current_player_id.
create or replace function public.vote_skip_reaction_window(p_round_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_poll_round integer;
  v_started_at timestamptz;
  v_votes integer;
begin
  v_player_id := public.current_player_id(p_round_id);

  select id, poll_round, poll_round_started_at
    into v_window_id, v_poll_round, v_started_at
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'vote_skip_reaction_window: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  if now() < v_started_at + interval '30 seconds' then
    raise exception 'vote_skip_reaction_window: voting opens 30 seconds after the poll round started'
      using errcode = 'RFB51';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id and excluded_at is null
  ) then
    raise exception 'vote_skip_reaction_window: only active round participants can vote'
      using errcode = 'RFB52';
  end if;

  if v_player_id in (select public._reaction_window_waiting_on(p_round_id, v_window_id, v_poll_round)) then
    raise exception 'vote_skip_reaction_window: the table is waiting on you; pass or react instead'
      using errcode = 'RFB52';
  end if;

  insert into public.spell_reaction_skip_votes (window_id, poll_round, player_id)
  values (v_window_id, v_poll_round, v_player_id)
  on conflict (window_id, poll_round, player_id) do nothing;

  select count(*) into v_votes
    from public.spell_reaction_skip_votes
   where window_id = v_window_id and poll_round = v_poll_round;

  if v_votes < public._reaction_skip_threshold(p_round_id) then
    return false;
  end if;

  perform public._auto_pass_reaction_window(p_round_id, v_window_id, 'vote');
  return true;
end;
$$;

revoke execute on function public.vote_skip_reaction_window(uuid) from public, anon;
grant execute on function public.vote_skip_reaction_window(uuid) to authenticated;

-- The stall backstop: auto-passes everyone still being waited on in the
-- round's open window and closes it. Returns who was auto-passed (empty when
-- no window is open). enforceStallTimeout decides that STALL_TIMEOUT_MS has
-- passed since poll_round_started_at before calling this.
create or replace function public.time_out_reaction_window(p_round_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_id uuid;
begin
  select id into v_window_id
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    return '{}';
  end if;

  return public._auto_pass_reaction_window(p_round_id, v_window_id, 'timeout');
end;
$$;

revoke execute on function public.time_out_reaction_window(uuid) from public, anon;
grant execute on function public.time_out_reaction_window(uuid) to authenticated;

-- The Skip vote state of the round's open reaction window, from the caller's
-- side: what the banner renders and what the stall backstop times. No row
-- when no window is open.
create or replace function public.get_reaction_window_skip_vote(p_round_id uuid)
returns table (
  poll_round_started_at timestamptz,
  votes integer,
  threshold integer,
  has_voted boolean,
  can_vote boolean,
  waited_on boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_poll_round integer;
  v_started_at timestamptz;
  v_waited_on boolean;
  v_active boolean;
begin
  v_player_id := public.current_player_id(p_round_id);

  select w.id, w.poll_round, w.poll_round_started_at
    into v_window_id, v_poll_round, v_started_at
    from public.spell_reaction_windows w
   where w.round_id = p_round_id and w.status = 'open'
   order by w.opened_at desc
   limit 1;

  if v_window_id is null then
    return;
  end if;

  v_waited_on := v_player_id in (select public._reaction_window_waiting_on(p_round_id, v_window_id, v_poll_round));
  v_active := exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id and excluded_at is null
  );

  poll_round_started_at := v_started_at;
  select count(*)::integer,
         coalesce(bool_or(v.player_id = v_player_id), false)
    into votes, has_voted
    from public.spell_reaction_skip_votes v
   where v.window_id = v_window_id and v.poll_round = v_poll_round;
  threshold := public._reaction_skip_threshold(p_round_id);
  can_vote := v_active and not v_waited_on;
  waited_on := v_waited_on;
  return next;
end;
$$;

revoke execute on function public.get_reaction_window_skip_vote(uuid) from public, anon;
grant execute on function public.get_reaction_window_skip_vote(uuid) to authenticated;
