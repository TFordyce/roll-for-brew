-- pass_reaction_window
--
-- A compelled Reaction holder cannot pass the Layer-0 window: they must cast
-- (or be skipped, which forfeits). Released holders (Brewmageddon countered)
-- pass as normal. Issue #439: who counts as passed is read off
-- _is_reaction_source, the predicate count_eligible_reaction_holders counts,
-- so a Courage Token holder's pass counts. Otherwise unchanged (0064).
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

  if exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.player_id = v_player_id and o.casting_time = 'R'
  ) then
    raise exception 'pass_reaction_window: Brewmageddon compels you to play your card'
      using errcode = 'RFB55';
  end if;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id)
  values (v_window_id, v_poll_round, v_player_id)
  on conflict (window_id, poll_round, player_id) do nothing;

  v_eligible_count := public.count_eligible_reaction_holders(p_round_id);

  select count(*) into v_passed_count
    from public.spell_reaction_passes p
   where p.window_id = v_window_id and p.poll_round = v_poll_round
     and public._is_reaction_source(p_round_id, p.player_id);

  if v_passed_count >= v_eligible_count then
    perform public.close_reaction_window(v_window_id);
    v_closed := true;
  end if;

  return v_closed;
end;
$$;
