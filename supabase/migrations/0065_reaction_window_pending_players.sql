-- Issue #250: the reaction window ribbon banner should name who it's
-- waiting on, not just show a generic "waiting" message. get_open_reaction_
-- window (0021/0026) only reports the caller's own eligibility/pass status;
-- this adds the full per-window breakdown of which round participants are
-- currently eligible (holding a usable Reaction card) and have not yet
-- passed the window's current poll round — the same set
-- get_open_reaction_window's `eligible`/`already_passed` columns describe
-- for the caller, but for everyone.
--
-- Pulls the two eligibility rules get_open_reaction_window already encodes
-- (holds a usable Reaction card; hasn't passed this poll round) into shared
-- helper functions rather than restating them, and redefines
-- get_open_reaction_window to call the same helpers so the two RPCs can't
-- drift on what "eligible"/"already passed" mean.
create or replace function public.holds_usable_reaction_card(p_player_id text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = p_player_id and sdi.location = 'held' and sc.casting_time = 'R'
  );
$$;

revoke execute on function public.holds_usable_reaction_card(text) from public, anon;
grant execute on function public.holds_usable_reaction_card(text) to authenticated;

create or replace function public.has_passed_reaction_poll(p_window_id uuid, p_poll_round integer, p_player_id text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.spell_reaction_passes p
     where p.window_id = p_window_id and p.poll_round = p_poll_round and p.player_id = p_player_id
  );
$$;

revoke execute on function public.has_passed_reaction_poll(uuid, integer, text) from public, anon;
grant execute on function public.has_passed_reaction_poll(uuid, integer, text) to authenticated;

create or replace function public.get_open_reaction_window(p_round_id uuid)
returns table (window_id uuid, layer integer, poll_round integer, eligible boolean, already_passed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select w.id, w.layer, w.poll_round,
      public.holds_usable_reaction_card(v_player_id)
        and exists (
          select 1 from public.round_participants rp
           where rp.round_id = p_round_id and rp.player_id = v_player_id
        ),
      public.has_passed_reaction_poll(w.id, w.poll_round, v_player_id)
      from public.spell_reaction_windows w
     where w.round_id = p_round_id and w.status = 'open'
     order by w.opened_at desc
     limit 1;
end;
$$;

revoke execute on function public.get_open_reaction_window(uuid) from public, anon;
grant execute on function public.get_open_reaction_window(uuid) to authenticated;

create or replace function public.get_reaction_window_pending_players(p_round_id uuid)
returns table (player_id text, display_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_id uuid;
  v_poll_round integer;
begin
  select w.id, w.poll_round into v_window_id, v_poll_round
    from public.spell_reaction_windows w
   where w.round_id = p_round_id and w.status = 'open'
   order by w.opened_at desc
   limit 1;

  if v_window_id is null then
    return;
  end if;

  return query
    select rp.player_id, coalesce(p.display_name, p.email)
      from public.round_participants rp
      join public.players p on p.id = rp.player_id
     where rp.round_id = p_round_id
       and public.holds_usable_reaction_card(rp.player_id)
       and not public.has_passed_reaction_poll(v_window_id, v_poll_round, rp.player_id)
     order by coalesce(p.display_name, p.email);
end;
$$;

revoke execute on function public.get_reaction_window_pending_players(uuid) from public, anon;
grant execute on function public.get_reaction_window_pending_players(uuid) to authenticated;
