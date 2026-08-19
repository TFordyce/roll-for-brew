-- Force the swap on a nat-1 draw while already holding a card (issue #267).
--
-- Previously every draw RPC treated nat-1 and nat-20 identically once the
-- player already held a card: the new instance was parked as
-- 'pending_swap' and needs_swap_decision came back true, so the player got
-- a "Keep New Card?" compare-and-choose prompt (SpellCardPanel.tsx)
-- regardless of which trigger drew it. That's a costless decline on a bad
-- roll — a nat-1 should feel bad, not offer an out. A nat-20 keeps the
-- existing compare-and-choose behaviour unchanged (pure upside, no reason
-- to force it).
--
-- The fix: when p_trigger is 'nat1' and the player already holds a card,
-- skip 'pending_swap' entirely — reshuffle the held card straight back to
-- 'in_deck' and seat the new one as 'held' in the same statement, with
-- needs_swap_decision coming back false. The player never sees the new
-- card before it replaces the old one; there's no preview, no "was this
-- forced" messaging, just a silent update to what's shown as held (per
-- issue #267 discussion). This mirrors resolve_card_swap's own
-- p_keep_new = true branch, just performed unconditionally instead of
-- behind a decision.
--
-- Restated identically across all four draw RPCs (draw_spell_card,
-- draw_spell_card_as, draw_pending_spell_card, draw_pending_spell_card_manual)
-- since each duplicates its own already-held/hold-or-park branch rather than
-- sharing one (0018/0034/0036) — same pattern those files already follow,
-- so this migration keeps following it rather than introducing a shared
-- helper on its own.
--
-- draw_spell_card's signature here is (text, uuid) — matching 0026's
-- replacement of the original 0018 (text)-only signature (0026 dropped
-- that one outright), not restated here since re-creating it would leave
-- both overloads live and ambiguous to PostgREST/Postgres.
create or replace function public.draw_spell_card(p_trigger text, p_room_id uuid default null)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_new_instance_id uuid;
  v_already_held boolean;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'draw_spell_card: invalid trigger %', p_trigger;
  end if;

  v_already_held := exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'held'
  );

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

  if v_already_held and p_trigger = 'nat1' then
    update public.spell_deck_instances
       set location = 'in_deck', held_by_player = null
     where held_by_player = v_player_id and location = 'held';

    update public.spell_deck_instances
       set location = 'held', held_by_player = v_player_id
     where id = v_new_instance_id;

    needs_swap_decision := false;
  else
    update public.spell_deck_instances
       set location = case when v_already_held then 'pending_swap' else 'held' end,
           held_by_player = v_player_id
     where id = v_new_instance_id;

    needs_swap_decision := v_already_held;
  end if;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (v_player_id, v_new_instance_id, p_trigger);

  instance_id := v_new_instance_id;
  return next;
end;
$$;

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

  if v_already_held and p_trigger = 'nat1' then
    update public.spell_deck_instances
       set location = 'in_deck', held_by_player = null
     where held_by_player = p_player_id and location = 'held';

    update public.spell_deck_instances
       set location = 'held', held_by_player = p_player_id
     where id = v_new_instance_id;

    needs_swap_decision := false;
  else
    update public.spell_deck_instances
       set location = case when v_already_held then 'pending_swap' else 'held' end,
           held_by_player = p_player_id
     where id = v_new_instance_id;

    needs_swap_decision := v_already_held;
  end if;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (p_player_id, v_new_instance_id, p_trigger);

  instance_id := v_new_instance_id;
  return next;
end;
$$;

create or replace function public.draw_pending_spell_card(p_round_id uuid)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_trigger text;
  v_new_instance_id uuid;
  v_already_held boolean;
begin
  v_player_id := public.current_player_id(p_round_id);

  select trigger into v_trigger
    from public.pending_spell_draws
   where round_id = p_round_id and player_id = v_player_id;

  if v_trigger is null then
    raise exception 'draw_pending_spell_card: caller has no pending spell draw for this round';
  end if;

  v_already_held := exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'held'
  );

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_pending_spell_card: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where location = 'in_deck'
   order by random()
   limit 1
     for update skip locked;

  delete from public.pending_spell_draws where round_id = p_round_id and player_id = v_player_id;

  if v_new_instance_id is null then
    return;
  end if;

  if v_already_held and v_trigger = 'nat1' then
    update public.spell_deck_instances
       set location = 'in_deck', held_by_player = null
     where held_by_player = v_player_id and location = 'held';

    update public.spell_deck_instances
       set location = 'held', held_by_player = v_player_id
     where id = v_new_instance_id;

    needs_swap_decision := false;
  else
    update public.spell_deck_instances
       set location = case when v_already_held then 'pending_swap' else 'held' end,
           held_by_player = v_player_id
     where id = v_new_instance_id;

    needs_swap_decision := v_already_held;
  end if;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (v_player_id, v_new_instance_id, v_trigger);

  instance_id := v_new_instance_id;
  return next;
end;
$$;

create or replace function public.draw_pending_spell_card_manual(p_round_id uuid, p_card_id uuid)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_trigger text;
  v_new_instance_id uuid;
  v_already_held boolean;
begin
  v_player_id := public.current_player_id(p_round_id);

  select trigger into v_trigger
    from public.pending_spell_draws
   where round_id = p_round_id and player_id = v_player_id;

  if v_trigger is null then
    raise exception 'draw_pending_spell_card_manual: caller has no pending spell draw for this round';
  end if;

  v_already_held := exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'held'
  );

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_pending_spell_card_manual: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where card_id = p_card_id and location = 'in_deck'
     for update skip locked;

  if v_new_instance_id is null then
    raise exception 'draw_pending_spell_card_manual: that card is not currently in the deck'
      using errcode = 'RFB06';
  end if;

  delete from public.pending_spell_draws where round_id = p_round_id and player_id = v_player_id;

  if v_already_held and v_trigger = 'nat1' then
    update public.spell_deck_instances
       set location = 'in_deck', held_by_player = null
     where held_by_player = v_player_id and location = 'held';

    update public.spell_deck_instances
       set location = 'held', held_by_player = v_player_id
     where id = v_new_instance_id;

    needs_swap_decision := false;
  else
    update public.spell_deck_instances
       set location = case when v_already_held then 'pending_swap' else 'held' end,
           held_by_player = v_player_id
     where id = v_new_instance_id;

    needs_swap_decision := v_already_held;
  end if;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (v_player_id, v_new_instance_id, v_trigger);

  instance_id := v_new_instance_id;
  return next;
end;
$$;
