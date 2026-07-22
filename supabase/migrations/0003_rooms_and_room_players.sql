-- Rooms: one per calendar day in Europe/London. Auto-created on the first
-- whitelisted login of that day (see enter_todays_room below); every
-- whitelisted login that same day joins the same room.
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

create policy "rooms are readable by authenticated users"
  on public.rooms for select
  to authenticated
  using (true);

-- Room players: one row per player present in a room that day. Created at
-- room-entry (login), independent of whether the player has played any
-- round yet, so "present today but hasn't played" is a real, queryable
-- state that drives the roster. modifier is scoped strictly to this one
-- room/day and starts at 0 — a new day's room always starts fresh, since
-- it's a brand new row, not a carry-over from a prior day's room.
create table if not exists public.room_players (
  room_id uuid not null references public.rooms (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  modifier integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (room_id, player_id)
);

alter table public.room_players enable row level security;

create policy "room_players are readable by authenticated users"
  on public.room_players for select
  to authenticated
  using (true);

-- No insert/update/delete policies are granted to anon/authenticated for
-- either table: the only writer is the function below, which runs as the
-- table owner and so bypasses RLS regardless of policies — mirroring the
-- players table's write path in 0001.

-- Idempotently ensures the caller has a room for "today" (Europe/London)
-- and a room_players row within it, then returns that room's id. Safe to
-- call on every login: the unique constraint on rooms.date plus "on
-- conflict do nothing" means a second call the same day joins the
-- already-created room instead of creating a duplicate, and the
-- room_players primary key plus "on conflict do nothing" means a repeat
-- login doesn't reset an in-progress modifier back to 0.
--
-- The caller's player id is derived server-side from auth.users, the same
-- way the upsert_player_from_auth_user trigger derives it (the Google
-- "sub" claim, falling back to the auth.users id) — never taken as a
-- parameter — so a client can only ever enter a room as themselves.
create or replace function public.enter_todays_room()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_date date;
  v_room_id uuid;
begin
  select coalesce(u.raw_user_meta_data ->> 'sub', u.id::text)
    into v_player_id
    from auth.users u
   where u.id = auth.uid();

  if v_player_id is null then
    raise exception 'enter_todays_room: no authenticated user';
  end if;

  v_date := (now() at time zone 'Europe/London')::date;

  insert into public.rooms (date)
  values (v_date)
  on conflict (date) do nothing;

  select id into v_room_id from public.rooms where date = v_date;

  insert into public.room_players (room_id, player_id)
  values (v_room_id, v_player_id)
  on conflict (room_id, player_id) do nothing;

  return v_room_id;
end;
$$;

revoke execute on function public.enter_todays_room() from public, anon;
grant execute on function public.enter_todays_room() to authenticated;
