-- _auto_pass_reaction_window
--
-- Skipped by the Skip vote or the stall backstop: a compelled Reaction holder
-- Forfeits instead of keeping the card (decided when #440 was ticketed). The
-- auto-pass rows are still written, so the Recap still names who wasn't
-- heard from. Otherwise unchanged (0114).
create or replace function public._auto_pass_reaction_window(
  p_round_id uuid, p_window_id uuid, p_reason text
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_round integer;
  v_players text[];
  v_player_id text;
begin
  select poll_round into v_poll_round
    from public.spell_reaction_windows
   where id = p_window_id;

  select coalesce(array_agg(w order by w), '{}')
    into v_players
    from public._reaction_window_waiting_on(p_round_id, p_window_id, v_poll_round) w;

  foreach v_player_id in array v_players loop
    perform public._forfeit_compelled_card(p_round_id, v_player_id, p_reason);
  end loop;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id, reason)
  select p_window_id, v_poll_round, unnest(v_players), p_reason
  on conflict (window_id, poll_round, player_id) do nothing;

  perform public.close_reaction_window(p_window_id);
  return v_players;
end;
$$;

revoke execute on function public._auto_pass_reaction_window(uuid, uuid, text) from public, anon, authenticated;
