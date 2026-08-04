-- Admin "force the crit card" (issue TBD): lets an admin choose which
-- specific spell card gets drawn when a Test Room "roll for others" roll
-- lands on nat-1/nat-20, instead of always taking the uniformly-random
-- instance draw_spell_card (0018/0026) picks for real gameplay.
--
-- draw_spell_card itself is deliberately left untouched — real gameplay's
-- randomness must never be steerable from a form field. Instead this adds a
-- parallel, explicitly admin-gated draw_spell_card_as, plus the catalog read
-- (get_in_deck_spell_cards) the admin picker needs to know what's actually
-- drawable right now (the deck stays blind everywhere else — user story 9 —
-- this is a deliberate, admin-only, Test-Room-only exception).
--
-- draw_spell_card_as also fixes a latent mismatch in the existing "roll for
-- others" flow: submit_roll_as/submit_manual_roll_as (0029) already take the
-- target player explicitly, but the maybeDrawSpellCard call that follows them
-- (src/app/rounds/roundActionHelpers.ts) draws via current_player_id(), which
-- resolves to whichever Test Player the admin is currently Acting As — not
-- necessarily the player who was just rolled for. draw_spell_card_as takes
-- p_player_id explicitly instead, the same way submit_roll_as does.
create or replace function public.draw_spell_card_as(
  p_trigger text,
  p_room_id uuid,
  p_player_id text,
  p_card_id uuid default null
)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_new_instance_id uuid;
  v_already_held boolean;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'draw_spell_card_as: caller is not an admin';
  end if;

  if not exists (select 1 from public.rooms where id = p_room_id and is_test) then
    raise exception 'draw_spell_card_as: room is not the Test Room';
  end if;

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'draw_spell_card_as: invalid trigger %', p_trigger;
  end if;

  v_already_held := exists (
    select 1 from public.spell_deck_instances
     where held_by_player = p_player_id and location = 'held'
  );

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = p_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_spell_card_as: target player already has a pending keep-or-swap decision';
  end if;

  if p_card_id is not null then
    select id into v_new_instance_id
      from public.spell_deck_instances
     where card_id = p_card_id and location = 'in_deck'
       for update skip locked;

    if v_new_instance_id is null then
      raise exception 'draw_spell_card_as: chosen card is not currently in the deck';
    end if;
  else
    select id into v_new_instance_id
      from public.spell_deck_instances
     where location = 'in_deck'
     order by random()
     limit 1
       for update skip locked;

    if v_new_instance_id is null then
      return;
    end if;
  end if;

  update public.spell_deck_instances
     set location = case when v_already_held then 'pending_swap' else 'held' end,
         held_by_player = p_player_id
   where id = v_new_instance_id;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (p_player_id, v_new_instance_id, p_trigger);

  instance_id := v_new_instance_id;
  needs_swap_decision := v_already_held;
  return next;
end;
$$;

revoke execute on function public.draw_spell_card_as(text, uuid, text, uuid) from public, anon;
grant execute on function public.draw_spell_card_as(text, uuid, text, uuid) to authenticated;

-- Lists every catalog card whose instance is currently drawable (location =
-- 'in_deck') in the given room's deck, for the admin "force this card"
-- picker (RollForOthers.tsx). Admin-only and Test-Room-only, same gate as
-- draw_spell_card_as above — the deck otherwise never discloses its
-- contents to anyone (user story 9).
create or replace function public.get_in_deck_spell_cards(p_room_id uuid)
returns table (card_id uuid, name text, tier text, target text, casting_time text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'get_in_deck_spell_cards: caller is not an admin';
  end if;

  if not exists (select 1 from public.rooms where id = p_room_id and is_test) then
    raise exception 'get_in_deck_spell_cards: room is not the Test Room';
  end if;

  return query
    select sc.id, sc.name, sc.tier, sc.target, sc.casting_time
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.location = 'in_deck'
     order by sc.tier, sc.name;
end;
$$;

revoke execute on function public.get_in_deck_spell_cards(uuid) from public, anon;
grant execute on function public.get_in_deck_spell_cards(uuid) to authenticated;
