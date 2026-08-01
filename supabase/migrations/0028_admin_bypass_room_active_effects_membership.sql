-- Fix get_room_active_effects() (0020, updated 0026): the admin/test-room
-- page (0026, issue #102) calls this unconditionally, including while the
-- admin is "acting as self" (the default, before puppeting anyone). In that
-- state current_player_id(null, p_room_id) returns the real admin's player
-- id, which is never a room_players row for the Test Room (only the four
-- seeded test players are, per 0024) — so the membership check raised
-- "caller is not a member of this room" on every load. Admins already get a
-- current_player_id override once they're acting as a roster member; this
-- adds the missing case of an admin merely *viewing* the Test Room without
-- puppeting anyone yet. Scoped to admins + Test Room only, same trust
-- boundary current_player_id itself uses, so this doesn't loosen visibility
-- for any real room.
create or replace function public.get_room_active_effects(p_room_id uuid)
returns table (
  effect_id uuid, target_player_id text, card_name text, tier text, polarity text, rounds_remaining integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_is_admin boolean;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  select is_admin into v_is_admin from public.players where id = v_player_id;

  if not (
    coalesce(v_is_admin, false)
    and exists (select 1 from public.rooms where id = p_room_id and is_test)
  ) and not exists (
    select 1 from public.room_players
     where room_id = p_room_id and player_id = v_player_id
  ) then
    raise exception 'get_room_active_effects: caller is not a member of this room';
  end if;

  return query
    select sae.id, sae.target_player_id, sc.name, sc.tier, sc.polarity, sae.rounds_remaining
      from public.spell_active_effects sae
      join public.spell_cards sc on sc.id = sae.card_id
     where sae.room_id = p_room_id;
end;
$$;

revoke execute on function public.get_room_active_effects(uuid) from public, anon;
grant execute on function public.get_room_active_effects(uuid) to authenticated;
