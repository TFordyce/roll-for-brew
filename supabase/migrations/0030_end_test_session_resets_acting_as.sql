-- End Test Session was a no-op from the admin's point of view whenever
-- they'd left themselves Acting As a Test Player and the room had no active
-- round to clear: nothing visibly changed, since the switcher stayed on the
-- puppeted identity. "Ending the session" should also hand control back to
-- the admin's own identity, so the button always has a visible effect and
-- the admin doesn't have to separately click back to themselves in Acting As.
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
  delete from public.admin_acting_as where admin_player_id = v_caller;
end;
$$;
