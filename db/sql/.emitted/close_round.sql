-- close_round(p_round_id uuid) -> void
--
-- Lock the roster and fan out a caster's TABLE / ALL_OTHER_PLAYERS
-- placeholder casts into one real spell_casts row per participant
-- (_fan_out_table_placeholder_casts, lifted out of this body unchanged in
-- issue #440), then fix Brewmageddon's compelled set (_fix_compelled_set) --
-- except in a debt round (issue #432), which the caller resolves straight
-- away by raising advanceRound's roundClosed event.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.close_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_started_by text;
  v_declared_count integer;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, started_by, room_id into v_status, v_started_by, v_room_id
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'close_round: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'close_round: round is not open';
  end if;

  if v_started_by <> v_player_id then
    raise exception 'close_round: only the round starter can close declarations';
  end if;

  select count(*) into v_declared_count
    from public.round_participants
   where round_id = p_round_id;

  if v_declared_count < 2 then
    raise exception 'close_round: at least 2 players must declare in before closing';
  end if;

  update public.rounds set status = 'closed', closed_at = now() where id = p_round_id;

  -- TABLE / ALL_OTHER_PLAYERS placeholders fan out against the final roster.
  perform public._fan_out_table_placeholder_casts(p_round_id);

  -- Issue #440: fix Brewmageddon's compelled set now the roster is locked,
  -- which starts the Compelled Cast step (rolling is held until every
  -- compelled Action cast is in) and forfeits any card with no legal target.
  -- issue #432: nobody casts in a debt round, which resolves at close
  -- (advanceRound's roundClosed event), so there is no compelled set to fix.
  if public._brew_debt_due(p_round_id) is null then
    perform public._fix_compelled_set(p_round_id);
  end if;
end;
$$;

revoke execute on function public.close_round(uuid) from public, anon;
grant execute on function public.close_round(uuid) to authenticated;
