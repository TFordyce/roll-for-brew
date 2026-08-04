-- Adds edition to public.spell_cards: every card currently in the catalog
-- (0017's original 65 plus 0036's v2-import 6, taking it to 71) is a 4th
-- edition physical card. Recorded now so a future edition's cards can be
-- added to the same table/deck without conflating them with this one — the
-- check constraint only allows '4th' today and grows the same way tier/
-- target/casting_time have (0033 extended target's check in place) once a
-- second edition actually exists.
alter table public.spell_cards
  add column edition text not null default '4th' check (edition in ('4th'));

-- Redefines get_my_spell_cards (0032) to also report each held card's
-- edition, same "just add the column to every column list" treatment as the
-- rest of this function's existing fields. Postgres won't let CREATE OR
-- REPLACE change a function's return-table shape, so it must be dropped
-- first (same reasoning as 0032's record_active_effect_if_persistent).
drop function if exists public.get_my_spell_cards(uuid);

create function public.get_my_spell_cards(p_room_id uuid default null)
returns table (
  instance_id uuid,
  location text,
  card_name text,
  casting_time text,
  target text,
  tier text,
  effect_text text,
  effect_kind text,
  edition text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  return query
    select sdi.id, sdi.location, sc.name, sc.casting_time, sc.target, sc.tier, sc.effect_text,
      case
        when (select count(*) from public.spell_card_effects sce where sce.card_id = sc.id) = 1
          then (select sce.effect_kind from public.spell_card_effects sce where sce.card_id = sc.id)
        else null
      end,
      sc.edition
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = v_player_id
       and sdi.location in ('held', 'pending_swap');
end;
$$;

revoke execute on function public.get_my_spell_cards(uuid) from public, anon;
grant execute on function public.get_my_spell_cards(uuid) to authenticated;

-- Redefines get_in_deck_spell_cards (0034) to also report edition, for the
-- same reason. Same drop-first requirement as above.
drop function if exists public.get_in_deck_spell_cards(uuid);

create function public.get_in_deck_spell_cards(p_room_id uuid)
returns table (card_id uuid, name text, tier text, target text, casting_time text, edition text)
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
    select sc.id, sc.name, sc.tier, sc.target, sc.casting_time, sc.edition
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.location = 'in_deck'
     order by sc.tier, sc.name;
end;
$$;

revoke execute on function public.get_in_deck_spell_cards(uuid) from public, anon;
grant execute on function public.get_in_deck_spell_cards(uuid) to authenticated;
