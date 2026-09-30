-- draw_spell_card_as(text, uuid, text, uuid, uuid) -> table (instance_id uuid, needs_swap_decision boolean)
--
-- Admin "draw for others" in the Test Room (0034; forced nat-1 swap from
-- 0070) -- the Test-room puppet path's crit draw, which draws immediately
-- with no pending_spell_draws row.
--
-- Issue #435 (spec #401 F6): gains p_round_id, the round the crit was rolled
-- in. When given, the draw goes to _apply_crit_redirect's recipient -- this is
-- the puppet path's crit entry point -- and a NULL recipient (a fizzled
-- redirect) draws nothing. Without it (a caller with no round in hand) the
-- draw goes to p_player_id as before. Placement is _land_drawn_instance's.
-- The old 4-arg signature is dropped so PostgREST sees one overload.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

drop function if exists public.draw_spell_card_as(text, uuid, text, uuid);

create or replace function public.draw_spell_card_as(
  p_trigger text,
  p_room_id uuid,
  p_player_id text,
  p_card_id uuid default null,
  p_round_id uuid default null
)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_player_id text;
  v_new_instance_id uuid;
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

  v_player_id := p_player_id;
  if p_round_id is not null then
    if not exists (select 1 from public.rounds where id = p_round_id and room_id = p_room_id) then
      raise exception 'draw_spell_card_as: round is not in this room';
    end if;

    v_player_id := public._apply_crit_redirect(p_round_id, p_player_id);
    if v_player_id is null then
      return;
    end if;
  end if;

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
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

  needs_swap_decision := public._land_drawn_instance(v_player_id, v_new_instance_id, p_trigger);
  instance_id := v_new_instance_id;
  return next;
end;
$$;

revoke execute on function public.draw_spell_card_as(text, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.draw_spell_card_as(text, uuid, text, uuid, uuid) to authenticated;
