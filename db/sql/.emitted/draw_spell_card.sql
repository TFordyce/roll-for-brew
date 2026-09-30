-- draw_spell_card(text, uuid) -> table (instance_id uuid, needs_swap_decision boolean)
--
-- In-app nat-1 / nat-20 draw for the caller (0018; (text, uuid) signature from
-- 0026; forced nat-1 swap from 0070). Placement is _land_drawn_instance's
-- (issue #435) -- verbatim from migration 0070 otherwise.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.draw_spell_card(p_trigger text, p_room_id uuid default null)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_new_instance_id uuid;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'draw_spell_card: invalid trigger %', p_trigger;
  end if;

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_spell_card: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where location = 'in_deck'
   order by random()
   limit 1
     for update skip locked;

  if v_new_instance_id is null then
    return;
  end if;

  needs_swap_decision := public._land_drawn_instance(v_player_id, v_new_instance_id, p_trigger);
  instance_id := v_new_instance_id;
  return next;
end;
$$;

revoke execute on function public.draw_spell_card(text, uuid) from public, anon;
grant execute on function public.draw_spell_card(text, uuid) to authenticated;
