-- Issue #250: the reaction window ribbon banner should name who it's
-- waiting on, not just show a generic "waiting" message. The existing
-- get_open_reaction_window (0021/0026) only reports the caller's own
-- eligibility/pass status; this adds the full per-window breakdown of
-- which round participants are currently eligible (holding a usable
-- Reaction card) and have not yet passed the window's current poll round —
-- the same set get_open_reaction_window's `eligible`/`already_passed`
-- columns describe for the caller, but for everyone.
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
       and exists (
         select 1 from public.spell_deck_instances sdi
         join public.spell_cards sc on sc.id = sdi.card_id
        where sdi.held_by_player = rp.player_id and sdi.location = 'held' and sc.casting_time = 'R'
       )
       and not exists (
         select 1 from public.spell_reaction_passes pass
          where pass.window_id = v_window_id and pass.poll_round = v_poll_round and pass.player_id = rp.player_id
       )
     order by coalesce(p.display_name, p.email);
end;
$$;

revoke execute on function public.get_reaction_window_pending_players(uuid) from public, anon;
grant execute on function public.get_reaction_window_pending_players(uuid) to authenticated;
