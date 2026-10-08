-- Port flags (spec #533 / issue #536): switch one TS wrapper between the SQL `.rpc` and the C# API.
-- slice = the wrapper's key (e.g. 'getActingAs'). room_id null = global row; a room row overrides the
-- global row for that room. No row = off (the `.rpc` path). Rollback = set enabled=false or delete the row.
-- Additive. Rows are written by hand (SQL editor / service role); there is no write policy and no UI.
create table public.port_flags (
  id         uuid primary key default gen_random_uuid(),
  slice      text not null check (length(slice) > 0),
  room_id    uuid references public.rooms (id) on delete cascade,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  unique nulls not distinct (slice, room_id)
);

alter table public.port_flags enable row level security;

-- Any signed-in client may read the flags (they hold no secrets); nobody writes through the API.
create policy port_flags_select on public.port_flags
  for select to authenticated using (true);
grant select on public.port_flags to authenticated;
