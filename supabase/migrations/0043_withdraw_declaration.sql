-- Cancel-an-accidental-declare (round-open "I'm in" has no undo currently,
-- so a mis-tap commits a player to the round until the starter closes
-- declarations or the round stalls out). Mirrors declare_in's own shape:
-- same 'open'-only guard, same current_player_id(p_round_id) caller
-- resolution. The round starter is excluded — their round_participants row
-- (inserted by start_round) represents them owning the round, not an
-- optional declaration, so it isn't withdrawable through this path.
create or replace function public.withdraw_declaration(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_started_by text;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, started_by into v_status, v_started_by
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'withdraw_declaration: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'withdraw_declaration: round is not open for declarations'
      using errcode = 'RFB05';
  end if;

  if v_player_id = v_started_by then
    raise exception 'withdraw_declaration: the round starter cannot withdraw their own declaration';
  end if;

  delete from public.round_participants
   where round_id = p_round_id and player_id = v_player_id;
end;
$$;

revoke execute on function public.withdraw_declaration(uuid) from public, anon;
grant execute on function public.withdraw_declaration(uuid) to authenticated;
