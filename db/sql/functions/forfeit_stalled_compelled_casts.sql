-- forfeit_stalled_compelled_casts
--
-- The stall clock's Compelled Cast branch: forfeits every compelled Action
-- cast still owed, which ends the step and lets rolling open. Returns who
-- forfeited. enforceStallTimeout (src/app/rounds/stallEnforcement.ts)
-- decides that STALL_TIMEOUT_MS has passed before calling this, like every
-- other stall RPC.
create or replace function public.forfeit_stalled_compelled_casts(p_round_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_forfeited text[] := '{}';
  v_player_id text;
begin
  perform 1 from public.rounds where id = p_round_id for update;

  for v_player_id in
    select o.player_id from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
     order by o.player_id
  loop
    if public._forfeit_compelled_card(p_round_id, v_player_id, 'stall') then
      v_forfeited := v_forfeited || v_player_id;
    end if;
  end loop;

  return v_forfeited;
end;
$$;

revoke execute on function public.forfeit_stalled_compelled_casts(uuid) from public, anon;
grant execute on function public.forfeit_stalled_compelled_casts(uuid) to authenticated;
