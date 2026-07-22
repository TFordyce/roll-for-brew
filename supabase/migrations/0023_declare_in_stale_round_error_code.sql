-- declare_in has its own "the round moved on under you" race: the page
-- only renders the declare-in form while a round is 'open', but close_round
-- can close it between that render and the form actually being submitted
-- (the same shape as submit_roll's RFB01, one phase earlier). Gives that
-- specific rejection its own SQLSTATE, RFB05, following the RFB01-04
-- convention from 0013/0019/0021 — not the exception message text, so a
-- cosmetic wording change can't silently break actions.ts's classifier.
create or replace function public.declare_in(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id();

  select status, room_id into v_status, v_room_id
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'declare_in: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'declare_in: round is not open for declarations'
      using errcode = 'RFB05';
  end if;

  if not exists (
    select 1 from public.room_players
     where room_id = v_room_id and player_id = v_player_id
  ) then
    raise exception 'declare_in: caller is not present in this round''s room';
  end if;

  insert into public.round_participants (round_id, player_id)
  values (p_round_id, v_player_id)
  on conflict (round_id, player_id) do nothing;
end;
$$;

revoke execute on function public.declare_in(uuid) from public, anon;
grant execute on function public.declare_in(uuid) to authenticated;

comment on function public.declare_in(uuid) is
  'Raises RFB05 (round not open for declarations) for the same stale-round race pattern as submit_roll''s RFB01/RFB02, cast_spell_card''s RFB03, and pass_reaction_window''s RFB04.';
