-- Admin access and the persistent Test Room (issue #101). Vocabulary and
-- rationale: CONTEXT.md, docs/adr/0001-admin-puppeting-via-current-player-id-override.md,
-- docs/adr/0002-test-room-modeled-as-a-dateless-room.md.

-- is_admin: granted only here, never via any in-app path. is_test is a
-- cosmetic marker only — no server-side behavior keys off it besides UI
-- badging.
alter table public.players add column if not exists is_admin boolean not null default false;
alter table public.players add column if not exists is_test boolean not null default false;

alter table public.rooms add column if not exists is_test boolean not null default false;

-- The Test Room is dateless (ADR 0002): a single persistent fixture, not
-- created fresh each day like a real room. "One room per day" now only
-- applies to non-test rooms.
alter table public.rooms alter column date drop not null;
alter table public.rooms drop constraint if exists rooms_date_key;
create unique index if not exists rooms_date_key on public.rooms (date) where not is_test;

-- Grants is_admin to the developer's own player, matched by whitelisted
-- email since the Google "sub" id isn't known until first login. A no-op
-- until that player has signed in at least once.
update public.players set is_admin = true where email = 'thomfordyce@gmail.com';

-- Seeds the single persistent Test Room and its fixed roster of Test
-- Players, joined into it. Idempotent: safe to re-run.
insert into public.rooms (date, is_test)
select null, true
where not exists (select 1 from public.rooms where is_test);

insert into public.players (id, email, display_name, is_test)
values
  ('test-player-1', 'test-player-1@rollforbrew.test', 'Test Player 1', true),
  ('test-player-2', 'test-player-2@rollforbrew.test', 'Test Player 2', true),
  ('test-player-3', 'test-player-3@rollforbrew.test', 'Test Player 3', true),
  ('test-player-4', 'test-player-4@rollforbrew.test', 'Test Player 4', true)
on conflict (id) do nothing;

insert into public.room_players (room_id, player_id)
select ro.id, p.id
from public.rooms ro
cross join public.players p
where ro.is_test and p.is_test
on conflict (room_id, player_id) do nothing;
