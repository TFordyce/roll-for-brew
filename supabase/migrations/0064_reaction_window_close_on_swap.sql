-- Fixes issue #251: resolving a keep-or-swap decision (0018) that drops a
-- player out of Reaction-card eligibility never re-checks whether the
-- round's open reaction window (0021) should now close. If that player was
-- the window's last eligible holder, the window is left `status = 'open'`
-- forever — every client shows "eligible: false" for everyone with no Pass
-- affordance for anyone to press, and the round can never finalize on its
-- own.
--
-- count_eligible_reaction_holders factors out the "how many Reaction-card
-- holders does this round currently have" query that open_reaction_window
-- and pass_reaction_window (0021) each duplicated inline, so all three call
-- sites (those two, plus resolve_card_swap below) read from one definition
-- and can't drift out of sync.
create or replace function public.count_eligible_reaction_holders(p_round_id uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.round_participants rp on rp.player_id = sdi.held_by_player
   where sdi.location = 'held' and sc.casting_time = 'R' and rp.round_id = p_round_id;
$$;

revoke execute on function public.count_eligible_reaction_holders(uuid) from public, anon;
grant execute on function public.count_eligible_reaction_holders(uuid) to authenticated;

-- The "mark it closed" companion to count_eligible_reaction_holders above —
-- the same three call sites (open_reaction_window, pass_reaction_window,
-- resolve_card_swap) each independently ran this update inline before this
-- migration; factored out for the same "can't drift out of sync" reason.
create or replace function public.close_reaction_window(p_window_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.spell_reaction_windows set status = 'closed', closed_at = now()
   where id = p_window_id;
$$;

revoke execute on function public.close_reaction_window(uuid) from public, anon;
grant execute on function public.close_reaction_window(uuid) to authenticated;

create or replace function public.open_reaction_window(p_round_id uuid, p_layer integer)
returns table (window_id uuid, is_closed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_id uuid;
  v_eligible_count integer;
begin
  if not exists (select 1 from public.rounds where id = p_round_id) then
    raise exception 'open_reaction_window: round not found';
  end if;

  insert into public.spell_reaction_windows (round_id, layer)
  values (p_round_id, p_layer)
  returning id into v_window_id;

  v_eligible_count := public.count_eligible_reaction_holders(p_round_id);

  if v_eligible_count = 0 then
    perform public.close_reaction_window(v_window_id);
  end if;

  window_id := v_window_id;
  is_closed := v_eligible_count = 0;
  return next;
end;
$$;

create or replace function public.pass_reaction_window(p_round_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_poll_round integer;
  v_eligible_count integer;
  v_passed_count integer;
  v_closed boolean := false;
begin
  v_player_id := public.current_player_id();

  select id, poll_round into v_window_id, v_poll_round
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'pass_reaction_window: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id)
  values (v_window_id, v_poll_round, v_player_id)
  on conflict (window_id, poll_round, player_id) do nothing;

  v_eligible_count := public.count_eligible_reaction_holders(p_round_id);

  select count(*) into v_passed_count
    from public.spell_reaction_passes p
    join public.spell_deck_instances sdi on sdi.held_by_player = p.player_id
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.round_participants rp on rp.player_id = sdi.held_by_player
   where p.window_id = v_window_id and p.poll_round = v_poll_round
     and sdi.location = 'held' and sc.casting_time = 'R' and rp.round_id = p_round_id;

  if v_passed_count >= v_eligible_count then
    perform public.close_reaction_window(v_window_id);
    v_closed := true;
  end if;

  return v_closed;
end;
$$;

-- Redefines resolve_card_swap (0018, widened with p_room_id by 0026) to
-- also close an open reaction window on the resolving player's currently
-- active round, if this decision has just dropped the eligible-holder count
-- to zero. Reuses the exact "at most one active (open/closed) round per
-- room" invariant rounds_one_active_per_room (0004) enforces, rather than
-- taking a round id as a new parameter — the caller only ever has a room id
-- in scope here (spell_deck_instances holds are global, not round-scoped;
-- see 0018's header comment), and a room can have at most one round whose
-- reaction window could possibly still be open.
--
-- Returns the round id whose window this call closed, or null if either no
-- window closed or p_room_id was omitted (no round context to check) — the
-- same "null means nothing to do" contract open_reaction_window's is_closed
-- flag and pass_reaction_window's boolean already give their callers, so
-- resolveCardSwapAction (src/app/rounds/actions.ts) can finalize the layer
-- in the same request/flow the way passReactionWindowAction already does
-- when its own pass closes the window.
drop function if exists public.resolve_card_swap(boolean, uuid);

create function public.resolve_card_swap(p_keep_new boolean, p_room_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_held_id uuid;
  v_pending_id uuid;
  v_round_id uuid;
  v_window_id uuid;
  v_closed_round_id uuid;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  select id into v_held_id
    from public.spell_deck_instances
   where held_by_player = v_player_id and location = 'held';

  select id into v_pending_id
    from public.spell_deck_instances
   where held_by_player = v_player_id and location = 'pending_swap';

  if v_pending_id is null then
    raise exception 'resolve_card_swap: caller has no pending keep-or-swap decision';
  end if;

  if p_keep_new then
    update public.spell_deck_instances set location = 'in_deck', held_by_player = null
     where id = v_held_id;
    update public.spell_deck_instances set location = 'held'
     where id = v_pending_id;
  else
    update public.spell_deck_instances set location = 'in_deck', held_by_player = null
     where id = v_pending_id;
  end if;

  if p_room_id is not null then
    select id into v_round_id
      from public.rounds
     where room_id = p_room_id and status in ('open', 'closed')
     limit 1;

    if v_round_id is not null then
      select id into v_window_id
        from public.spell_reaction_windows
       where round_id = v_round_id and status = 'open'
       order by opened_at desc
       limit 1
         for update;

      if v_window_id is not null
         and public.count_eligible_reaction_holders(v_round_id) = 0 then
        perform public.close_reaction_window(v_window_id);
        v_closed_round_id := v_round_id;
      end if;
    end if;
  end if;

  return v_closed_round_id;
end;
$$;

revoke execute on function public.resolve_card_swap(boolean, uuid) from public, anon;
grant execute on function public.resolve_card_swap(boolean, uuid) to authenticated;
