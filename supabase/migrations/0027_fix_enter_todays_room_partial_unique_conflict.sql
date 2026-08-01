-- Fix enter_todays_room() (0003): 0024 replaced rooms' plain unique
-- constraint on date with a partial unique index (rooms_date_key, "where not
-- is_test") so the dateless Test Room could coexist with same-valued nulls.
-- The insert's "on conflict (date) do nothing" stopped matching any arbiter
-- once the constraint became partial, since Postgres only infers a partial
-- index as the arbiter when the on conflict clause repeats its predicate —
-- so every real (non-test) room entry after 0024 raised 42P10 ("no unique or
-- exclusion constraint matching the ON CONFLICT specification"). This insert
-- only ever creates real rooms (date is always non-null here, is_test is
-- never set), so repeating the index's predicate is the correct fix.
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
  on conflict (date) where not is_test do nothing;

  select id into v_room_id from public.rooms where date = v_date;

  insert into public.room_players (room_id, player_id)
  values (v_room_id, v_player_id)
  on conflict (room_id, player_id) do nothing;

  return v_room_id;
end;
$$;

revoke execute on function public.enter_todays_room() from public, anon;
grant execute on function public.enter_todays_room() to authenticated;
