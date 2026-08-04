-- End Test Session left room_players.modifier (the running per-room bonus
-- accumulated by resolve_round() and spell-card effects — see 0003 and
-- 0006, both of which document it as resetting to 0 for every new room)
-- untouched. Every real room is a brand-new row per calendar day, so that
-- reset happens for free; the Test Room is the one room that's never
-- recreated between sessions (it's permanently seeded, ADR 0002), so the
-- previous session's accumulated modifiers leaked into the next one even
-- though rounds/rolls/casts/effects were being cleared. Zero them out here
-- too so the roster is actually "ready for next time" as documented.
create or replace function public.end_test_session()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_test_room_id uuid;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'end_test_session: caller is not an admin';
  end if;

  select id into v_test_room_id from public.rooms where is_test limit 1;
  if v_test_room_id is null then
    raise exception 'end_test_session: test room not found';
  end if;

  delete from public.spell_active_effects where room_id = v_test_room_id;
  delete from public.rounds where room_id = v_test_room_id;
  update public.room_players set modifier = 0 where room_id = v_test_room_id;
  delete from public.admin_acting_as where admin_player_id = v_caller;
end;
$$;
