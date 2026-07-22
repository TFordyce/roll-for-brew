-- Whitelist: server-side only. RLS is enabled with zero policies, which
-- denies all access to anon/authenticated roles by default; only the
-- service_role (bypasses RLS) or the SQL editor / migrations can read or
-- write it. Nothing in the app ever exposes a client path to this table.
create table if not exists public.whitelist (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table public.whitelist enable row level security;

-- Players: identity mirrored from the Google OAuth profile on first login.
-- id is the Google "sub" claim (stable, unique per Google account), not the
-- Supabase-generated auth.users.id, so a player's identity survives even if
-- the underlying auth.users row is ever recreated.
create table if not exists public.players (
  id text primary key,
  email text not null,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.players enable row level security;

create policy "players are readable by authenticated users"
  on public.players for select
  to authenticated
  using (true);

-- No insert/update/delete policies are granted to anon/authenticated: the
-- only writer is the trigger function below, which runs as the table owner
-- and so bypasses RLS regardless of policies.

-- Rejects sign-in outright for any identity whose email isn't on the
-- whitelist. Wired up as the "Before User Created" Auth Hook in
-- supabase/config.toml, which Supabase Auth calls for every new user
-- (including OAuth sign-ins) before the auth.users row is created. An
-- "error" return blocks user creation entirely, so a rejected identity gets
-- no auth.users row and no session.
create or replace function public.check_whitelist_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_email text;
begin
  user_email := lower(event -> 'user' ->> 'email');

  if user_email is null or not exists (
    select 1 from public.whitelist w where lower(w.email) = user_email
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'This Google account is not on the Roll for Brew whitelist.'
      )
    );
  end if;

  return '{}'::jsonb;
end;
$$;

revoke execute on function public.check_whitelist_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.check_whitelist_before_user_created(jsonb) to supabase_auth_admin;

-- Upserts public.players from the Google identity every time an auth.users
-- row is created or updated, so a returning player's display name/avatar
-- stay in sync with their Google profile. Runs after check_whitelist_before_user_created
-- has already accepted the sign-in, so only whitelisted identities ever
-- reach this trigger.
create or replace function public.upsert_player_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.players (id, email, display_name, avatar_url)
  values (
    coalesce(new.raw_user_meta_data ->> 'sub', new.id::text),
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_upsert_player on auth.users;
create trigger on_auth_user_upsert_player
  after insert or update on auth.users
  for each row
  execute function public.upsert_player_from_auth_user();
