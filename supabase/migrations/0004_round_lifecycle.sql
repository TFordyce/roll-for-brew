-- Round lifecycle: start / declare-in / close gating (issue #18). No
-- rolling/resolution logic yet — status only ever reaches 'closed' here.
-- 'resolved' and 'cancelled' are reserved for later tickets (#19 rolls a
-- closed round to resolution; stall-timeout cancellation is later still) but
-- are included in the check constraint now so this column doesn't need a
-- migration to widen it when that work lands.
--
-- 'closed' (distinct from 'open') exists so a round can stop accepting
-- declarations without yet being resolved — #19 needs an unambiguous signal
-- for "declarations are locked, rolling can begin".
create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  started_by text not null references public.players (id),
  status text not null default 'open'
    check (status in ('open', 'closed', 'resolved', 'cancelled')),
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  brewer_id text references public.players (id),
  cups_made integer
);

alter table public.rounds enable row level security;

create policy "rounds are readable by authenticated users"
  on public.rounds for select
  to authenticated
  using (true);

-- "Only one active Round per Room at a time": active means still in
-- progress (open, accepting declarations, or closed and awaiting rolls) —
-- not yet resolved or cancelled. A second start attempt while one is active
-- hits this unique index and fails with a clean 23505 (unique_violation).
create unique index if not exists rounds_one_active_per_room
  on public.rounds (room_id)
  where status in ('open', 'closed');

-- Round participants: the declare-in ("I'm in") phase. Append-only — a
-- player either has declared for a round or hasn't; there's no "undeclare".
-- Row count for a round doubles as the "min 2 declared" check.
create table if not exists public.round_participants (
  round_id uuid not null references public.rounds (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  declared_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

alter table public.round_participants enable row level security;

create policy "round_participants are readable by authenticated users"
  on public.round_participants for select
  to authenticated
  using (true);

-- No insert/update/delete policies on either table: the only writers are
-- the security definer functions below, which bypass RLS as the table
-- owner — same pattern as rooms/room_players in 0003.

-- Shared identity derivation for the functions below: the caller's player
-- id, the same way the upsert_player_from_auth_user trigger derives it (see
-- 0001) — the Google "sub" claim, falling back to the auth.users id. Raises
-- if called with no authenticated caller, so every function below can just
-- trust the returned value rather than re-checking for null.
create or replace function public.current_player_id()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  select coalesce(u.raw_user_meta_data ->> 'sub', u.id::text)
    into v_player_id
    from auth.users u
   where u.id = auth.uid();

  if v_player_id is null then
    raise exception 'current_player_id: no authenticated user';
  end if;

  return v_player_id;
end;
$$;

revoke execute on function public.current_player_id() from public, anon;
grant execute on function public.current_player_id() to authenticated;

-- Starts a new round in the caller's room for today (Europe/London),
-- auto-enrolling the caller as its first round_participants row. The
-- caller's player id is derived server-side from auth.users (never a
-- client parameter), so a round can only ever be started "as yourself",
-- and started_by — the sole authority for closing it — can't be spoofed.
--
-- Relies on today's room already existing (created by enter_todays_room on
-- login, before any round can be started) and fails loudly if it doesn't,
-- rather than silently creating one, since a round with no prior room entry
-- would indicate a caller who skipped the normal login flow.
--
-- Fails cleanly (23505 unique_violation) via rounds_one_active_per_room if
-- another round in the room is already open or closed.
create or replace function public.start_round()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_date date;
  v_room_id uuid;
  v_round_id uuid;
begin
  v_player_id := public.current_player_id();

  v_date := (now() at time zone 'Europe/London')::date;

  select id into v_room_id from public.rooms where date = v_date;

  if v_room_id is null then
    raise exception 'start_round: no room for today';
  end if;

  insert into public.rounds (room_id, started_by, status)
  values (v_room_id, v_player_id, 'open')
  returning id into v_round_id;

  insert into public.round_participants (round_id, player_id)
  values (v_round_id, v_player_id);

  return v_round_id;
end;
$$;

revoke execute on function public.start_round() from public, anon;
grant execute on function public.start_round() to authenticated;

-- Declares the caller in for an open round. Idempotent (on conflict do
-- nothing) so a double-tap doesn't error. Requires the round to still be
-- open (declarations aren't accepted once closed) and the caller to already
-- be present in the round's room (a room_players row from login) — a player
-- who logs in mid-day joins the room via enter_todays_room as normal, but
-- is never retroactively added to a round that was already open before
-- they arrived; they can only declare in from here on.
create or replace function public.declare_in(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id();

  select status, room_id into v_status, v_room_id
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'declare_in: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'declare_in: round is not open for declarations';
  end if;

  if not exists (
    select 1 from public.room_players
     where room_id = v_room_id and player_id = v_player_id
  ) then
    raise exception 'declare_in: caller is not present in this round''s room';
  end if;

  insert into public.round_participants (round_id, player_id)
  values (p_round_id, v_player_id)
  on conflict (round_id, player_id) do nothing;
end;
$$;

revoke execute on function public.declare_in(uuid) from public, anon;
grant execute on function public.declare_in(uuid) to authenticated;

-- Closes declarations on a round, gated on: caller is the round's starter
-- (server-derived identity, not a client parameter — the sole authority
-- check for this action) and at least 2 players have declared in. Locks the
-- round row (for update) so two concurrent close attempts can't both pass
-- the declared-count check before either commits.
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

  update public.rounds set status = 'closed' where id = p_round_id;
end;
$$;

revoke execute on function public.close_round(uuid) from public, anon;
grant execute on function public.close_round(uuid) to authenticated;
